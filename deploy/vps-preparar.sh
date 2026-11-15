#!/usr/bin/env bash
# Instala ou atualiza o MelodIA Orquestra numa VPS Linux (Ubuntu/Debian), atrás de proxy reverso com HTTPS.
# Uso (root ou sudo), na pasta do app (/opt/melodia):
#   bash deploy/vps-preparar.sh --dominio melodia.m3d.pro [--email voce@exemplo.com] [--porta 3200] [--env /tmp/melodia.env]
# É o que o GitHub Actions roda a cada push na main. Pode rodar quantas vezes quiser:
#   1. garante Node.js >= 22.13 só para este app (não mexe no Node dos outros apps da VPS);
#   2. escolhe uma porta livre acima de 1000 (só na 1ª vez; fica gravada no .env) e prende o app em 127.0.0.1;
#   3. aplica as chaves (--env), guarda o banco em /var/lib/melodia e (re)inicia o serviço systemd "melodia";
#   4. configura o proxy reverso do domínio (nginx existente, Caddy existente ou instala nginx) e o HTTPS;
#   5. ativa o backup diário do banco e confere se o app responde pela porta local e pelo domínio.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then exec sudo -E bash "$0" "$@"; fi
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
APP_USER="melodia"
DATA_DIR="${MELODIA_DATA:-/var/lib/melodia}"
NODE_DIR="/opt/melodia-node"
NODE_MIN="22.13.0"

DOMINIO=""; EMAIL=""; PORTA_PEDIDA=""; ENV_NOVO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dominio) DOMINIO="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --porta) PORTA_PEDIDA="${2:-}"; shift 2 ;;
    --env) ENV_NOVO="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DOMINIO" ] || { echo "Informe --dominio (ex.: --dominio melodia.m3d.pro)" >&2; exit 2; }
URL="https://$DOMINIO"

ok()  { printf '\033[32m✔\033[0m %s\n' "$*"; }
av()  { printf '\033[33m!\033[0m %s\n' "$*"; }
erro(){ printf '\033[31m✘\033[0m %s\n' "$*" >&2; }
titulo(){ printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
export DEBIAN_FRONTEND=noninteractive
apt_instalar(){ command -v apt-get >/dev/null 2>&1 || { erro "Sem apt-get: instale manualmente: $*"; return 1; }; apt-get update -qq >/dev/null; apt-get install -y -qq "$@" >/dev/null; }

# ---------- 0) DNS ----------
titulo "DNS de $DOMINIO"
command -v curl >/dev/null 2>&1 || apt_instalar curl ca-certificates
IP_VPS="$(curl -fsS4 --max-time 6 https://api.ipify.org 2>/dev/null || { hostname -I 2>/dev/null || true; } | awk '{print $1}')"
IP_DNS="$( { getent ahostsv4 "$DOMINIO" 2>/dev/null || true; } | awk 'NR==1{print $1}')"
DNS_OK=0
if [ -z "$IP_DNS" ]; then av "$DOMINIO ainda não resolve. Crie um registro A: $DOMINIO -> $IP_VPS (o HTTPS fica para a próxima execução)."
elif [ "$IP_DNS" != "$IP_VPS" ]; then av "$DOMINIO aponta para $IP_DNS, mas esta VPS é $IP_VPS (Cloudflare com proxy laranja também causa isso)."
else DNS_OK=1; ok "$DOMINIO -> $IP_VPS"; fi

# ---------- recursos da VPS (para o canto neural) ----------
titulo "Recursos da VPS"
echo "CPU: $(nproc) núcleos · $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs)"
echo "Flags: $(grep -m1 -o -w -E 'avx2|avx512f' /proc/cpuinfo | sort -u | xargs)"
free -m | awk 'NR==2{print "RAM: "$2" MB total, "$7" MB disponível"} NR==3{print "Swap: "$2" MB"}'
df -h / | awk 'NR==2{print "Disco: "$4" livres de "$2}'
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || echo "GPU: nenhuma"
echo "Python: $(python3 --version 2>&1) · pip: $(python3 -m pip --version 2>/dev/null | cut -d' ' -f2 || echo ausente) · venv: $(python3 -c 'import venv' 2>/dev/null && echo ok || echo ausente)"
echo "Carga: $(cut -d' ' -f1-3 /proc/loadavg) · SO: $(. /etc/os-release; echo $PRETTY_NAME)"
command -v docker >/dev/null 2>&1 && echo "Docker: $(docker --version | cut -d, -f1)" || echo "Docker: ausente"

# ---------- 1) Node.js >= 22.13 (node:sqlite) ----------
titulo "Node.js"
command -v ss >/dev/null 2>&1 || apt_instalar iproute2
command -v xz >/dev/null 2>&1 || apt_instalar xz-utils
versao_ok(){ [ -x "$1" ] && "$1" -e "const[a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" 2>/dev/null; }
NODE_BIN=""
SYS_NODE="$(command -v node || true)"
if [ -n "$SYS_NODE" ] && versao_ok "$SYS_NODE"; then NODE_BIN="$(readlink -f "$SYS_NODE")"
elif versao_ok "$NODE_DIR/bin/node"; then NODE_BIN="$NODE_DIR/bin/node"
else
  case "$(uname -m)" in x86_64) ARQ=x64 ;; aarch64|arm64) ARQ=arm64 ;; *) erro "Arquitetura $(uname -m) sem binário oficial do Node"; exit 1 ;; esac
  av "Baixando Node.js 22 (só para o MelodIA, em $NODE_DIR)…"
  BASE="https://nodejs.org/dist/latest-v22.x"
  LINHA="$(curl -fsSL "$BASE/SHASUMS256.txt" | grep -E "node-v[0-9.]+-linux-$ARQ\.tar\.xz\$" | head -1)"
  [ -n "$LINHA" ] || { erro "Não achei o Node 22 para linux-$ARQ em $BASE"; exit 1; }
  SOMA="${LINHA%% *}"; ARQV="${LINHA##* }"; TMPN="$(mktemp -d)"
  curl -fsSL "$BASE/$ARQV" -o "$TMPN/$ARQV"
  echo "$SOMA  $TMPN/$ARQV" | sha256sum -c --quiet - || { erro "Checksum do Node não confere"; exit 1; }
  rm -rf "$NODE_DIR.novo"; mkdir -p "$NODE_DIR.novo"; tar -xJf "$TMPN/$ARQV" -C "$NODE_DIR.novo" --strip-components=1
  rm -rf "$NODE_DIR"; mv "$NODE_DIR.novo" "$NODE_DIR"; rm -rf "$TMPN"
  NODE_BIN="$NODE_DIR/bin/node"
fi
ok "Node $("$NODE_BIN" -v) em $NODE_BIN"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

# ---------- 2) porta (só escolhe na primeira vez), dados e chaves ----------
titulo "Porta, dados e chaves"
ENVC="$APP_DIR/.env"
[ -f "$ENVC" ] || { cp "$APP_DIR/.env.example" "$ENVC"; sed -i '/^PORT=/d' "$ENVC"; }
lerenv(){ { grep -E "^$1=" "$ENVC" 2>/dev/null || true; } | tail -1 | cut -d= -f2-; }
gravar(){ if grep -qE "^$1=" "$ENVC"; then sed -i "s|^$1=.*|$1=$2|" "$ENVC"; else echo "$1=$2" >> "$ENVC"; fi; }
ocupada(){ ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; }
livre_a_partir(){ local p="$1"; while ocupada "$p"; do p=$((p+1)); done; echo "$p"; }

if [ -n "$ENV_NOVO" ] && [ -f "$ENV_NOVO" ]; then
  PORTA_ATUAL="$(lerenv PORT)"
  { grep -vE '^(PORT|HOST|DATA_DIR|TRUST_PROXY|COOKIE_SECURE|CANTO_PORT|CANTO_MODELS)=' "$ENV_NOVO" | tr -d '\r'; [ -n "$PORTA_ATUAL" ] && echo "PORT=$PORTA_ATUAL" || true; CP="$(lerenv CANTO_PORT)"; [ -n "$CP" ] && echo "CANTO_PORT=$CP" || true; } > "$ENVC.novo"
  mv "$ENVC.novo" "$ENVC"; rm -f "$ENV_NOVO"; ok "Chaves atualizadas a partir do segredo MELODIA_ENV"
fi
if [ -z "$(lerenv PORT)" ]; then
  if [ -n "$PORTA_PEDIDA" ]; then
    [ "$PORTA_PEDIDA" -gt 1000 ] 2>/dev/null || { erro "--porta deve ser maior que 1000"; exit 2; }
    ocupada "$PORTA_PEDIDA" && { erro "A porta $PORTA_PEDIDA já está em uso."; exit 1; }
    gravar PORT "$PORTA_PEDIDA"
  else gravar PORT "$(livre_a_partir 3200)"; fi
fi
PORTA="$(lerenv PORT)"
CERT="/etc/letsencrypt/live/$DOMINIO"
gravar HOST "127.0.0.1"
gravar DATA_DIR "$DATA_DIR"
gravar TRUST_PROXY "true"
if [ -f "$CERT/fullchain.pem" ] || systemctl is-active --quiet caddy 2>/dev/null; then gravar COOKIE_SECURE true; else gravar COOKIE_SECURE false; fi
mkdir -p "$DATA_DIR/backups"
chown -R root:root "$APP_DIR"; chmod -R a+rX "$APP_DIR"
chown "root:$APP_USER" "$ENVC"; chmod 640 "$ENVC"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"; chmod 750 "$DATA_DIR"
ok "Porta interna: $PORTA (somente 127.0.0.1) · banco em $DATA_DIR"

# ---------- 2b) canto natural: Python isolado, voz neural Piper e vocoder WORLD ----------
titulo "Canto natural (voz neural)"
CANTO_VENV="/opt/melodia-canto/venv"; MODELOS="$DATA_DIR/canto-modelos"; CANTO_OK=0
canto_instalar(){
  command -v python3 >/dev/null 2>&1 || apt_instalar python3
  command -v espeak-ng >/dev/null 2>&1 || apt_instalar espeak-ng || true
  if [ ! -x "$CANTO_VENV/bin/python" ]; then
    python3 -m venv "$CANTO_VENV" 2>/dev/null || { apt_instalar python3-venv python3-dev build-essential && python3 -m venv "$CANTO_VENV"; } || return 1
  fi
  HREQ="$(sha256sum "$APP_DIR/canto/requirements.txt" | cut -c1-16)$(grep -qE '^CANTO_GPU=hf' "$ENVC" && echo hf)"
  if [ "$(cat "$CANTO_VENV/.req" 2>/dev/null)" != "$HREQ" ]; then
    av "Instalando dependências do canto (1ª vez demora alguns minutos)…"
    "$CANTO_VENV/bin/pip" install -q --upgrade pip wheel >/dev/null 2>&1 || true
    if ! "$CANTO_VENV/bin/pip" install -q -r "$APP_DIR/canto/requirements.txt" 2>/tmp/melodia-pip.log; then
      command -v g++ >/dev/null 2>&1 || apt_instalar python3-dev build-essential
      "$CANTO_VENV/bin/pip" install -q -r "$APP_DIR/canto/requirements.txt" 2>/tmp/melodia-pip.log || { tail -15 /tmp/melodia-pip.log; return 1; }
    fi
    if grep -qE '^CANTO_GPU=hf' "$ENVC"; then "$CANTO_VENV/bin/pip" install -q "gradio_client>=1,<2" || av "gradio_client não instalou (GPU externa via Hugging Face indisponível)"; fi
    echo "$HREQ" > "$CANTO_VENV/.req"
  fi
  mkdir -p "$MODELOS"
  for f in pt_BR-faber-medium.onnx pt_BR-faber-medium.onnx.json; do
    if [ ! -s "$MODELOS/$f" ]; then
      av "Baixando a voz neural $f…"
      curl -fsSL --retry 3 -o "$MODELOS/$f.part" "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/pt/pt_BR/faber/medium/$f" && mv "$MODELOS/$f.part" "$MODELOS/$f" || return 1
    fi
  done
  [ "$(stat -c %s "$MODELOS/pt_BR-faber-medium.onnx")" -gt 50000000 ] || { erro "Modelo de voz incompleto"; rm -f "$MODELOS/pt_BR-faber-medium.onnx"; return 1; }
  chown -R "$APP_USER:$APP_USER" "$MODELOS" 2>/dev/null || true
  [ -n "$(lerenv CANTO_PORT)" ] || gravar CANTO_PORT "$(livre_a_partir 3290)"
  gravar CANTO_MODELS "$MODELOS"
  sed -e "s#__DIR__#$APP_DIR#g" -e "s#__USER__#$APP_USER#g" -e "s#__VENV__#$CANTO_VENV#g" -e "s#__DATA__#$DATA_DIR#g" "$APP_DIR/deploy/melodia-canto.service" > /etc/systemd/system/melodia-canto.service
  systemctl daemon-reload; systemctl enable melodia-canto >/dev/null 2>&1; systemctl restart melodia-canto
  for i in $(seq 1 45); do curl -fsS --max-time 2 "http://127.0.0.1:$(lerenv CANTO_PORT)/status" >/dev/null 2>&1 && return 0; sleep 2; done
  journalctl -u melodia-canto -n 25 --no-pager || true; return 1
}
if canto_instalar; then
  CANTO_OK=1; ok "Canto natural ativo em 127.0.0.1:$(lerenv CANTO_PORT): $(curl -fsS "http://127.0.0.1:$(lerenv CANTO_PORT)/status")"
else
  av "Canto natural não ficou pronto: o app segue com a voz do navegador (veja os erros acima)."
  sed -i '/^CANTO_PORT=/d' "$ENVC"; systemctl disable --now melodia-canto >/dev/null 2>&1 || true
fi
free -m | awk 'NR==2{print "RAM livre agora: "$7" MB"}'

# ---------- 3) teste rápido e serviço ----------
titulo "Serviço"
testar(){ (cd "$APP_DIR" && "$NODE_BIN" --disable-warning=ExperimentalWarning test/smoke.js >/tmp/melodia-teste.log 2>&1); }
if ! testar && ! testar; then
  erro "Teste de fumaça falhou na VPS (o serviço antigo continua no ar):"; tail -20 /tmp/melodia-teste.log; exit 1
fi
ok "Teste de fumaça passou"
sed -e "s#__DIR__#$APP_DIR#g" -e "s#__USER__#$APP_USER#g" -e "s#__NODE__#$NODE_BIN#g" -e "s#__DATA__#$DATA_DIR#g" "$APP_DIR/deploy/melodia.service" > /etc/systemd/system/melodia.service
systemctl daemon-reload
systemctl enable melodia >/dev/null 2>&1
systemctl restart melodia
sleep 3
systemctl is-active --quiet melodia && ok "Serviço melodia ativo" || { erro "O serviço não subiu: journalctl -u melodia -n 50"; journalctl -u melodia -n 30 --no-pager || true; exit 1; }

# ---------- 4) proxy reverso + HTTPS ----------
titulo "Proxy reverso $DOMINIO -> 127.0.0.1:$PORTA"
ativo(){ systemctl is-active --quiet "$1" 2>/dev/null; }
dono_porta(){ ss -ltnpH "( sport = :$1 )" 2>/dev/null | grep -o 'users:(("[^"]*' | head -1 | cut -d'"' -f2; }
MODO=""
if ativo nginx; then MODO=nginx
elif ativo caddy; then MODO=caddy
else
  D80="$(dono_porta 80)"; D443="$(dono_porta 443)"
  if [ -n "$D80$D443" ]; then
    erro "As portas 80/443 estão com outro programa (${D80:-?}/${D443:-?}), que não é nginx nem Caddy."
    echo "   Configure nele: $DOMINIO -> http://127.0.0.1:$PORTA"; exit 1
  fi
  av "Nenhum proxy encontrado: instalando o nginx…"; apt_instalar nginx; systemctl enable --now nginx >/dev/null 2>&1; MODO=nginx
fi
if [ "$MODO" = nginx ]; then
  if [ -d /etc/nginx/sites-available ]; then CONF="/etc/nginx/sites-available/$DOMINIO.conf"; LINK="/etc/nginx/sites-enabled/$DOMINIO.conf"
  else CONF="/etc/nginx/conf.d/$DOMINIO.conf"; LINK=""; fi
  CERT="/etc/letsencrypt/live/$DOMINIO"
  bloco_proxy="    client_max_body_size 40m;
    location / {
        proxy_pass http://127.0.0.1:$PORTA;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$melodia_conexao;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }"
  escrever_conf(){
    {
      echo "# MelodIA Orquestra — gerado por deploy/vps-preparar.sh (é regravado a cada atualização)"
      echo "map \$http_upgrade \$melodia_conexao { default upgrade; '' close; }"
      if [ -f "$CERT/fullchain.pem" ]; then
        echo "server { listen 80; listen [::]:80; server_name $DOMINIO;"
        echo "    location /.well-known/acme-challenge/ { root /var/www/html; }"
        echo "    location / { return 301 https://\$host\$request_uri; } }"
        echo "server { listen 443 ssl; listen [::]:443 ssl; http2 on; server_name $DOMINIO;"
        echo "    ssl_certificate $CERT/fullchain.pem; ssl_certificate_key $CERT/privkey.pem;"
        [ -f /etc/letsencrypt/options-ssl-nginx.conf ] && echo "    include /etc/letsencrypt/options-ssl-nginx.conf;"
        echo "$bloco_proxy"; echo "}"
      else
        echo "server { listen 80; listen [::]:80; server_name $DOMINIO;"
        echo "    location /.well-known/acme-challenge/ { root /var/www/html; }"
        echo "$bloco_proxy"; echo "}"
      fi
    } > "$CONF"
    [ -n "$LINK" ] && ln -sf "$CONF" "$LINK"
    rm -f "/etc/nginx/sites-enabled/$DOMINIO" 2>/dev/null || true   # versão antiga deste script
    if ! nginx -t >/dev/null 2>&1; then
      sed -i 's/listen 443 ssl; listen \[::\]:443 ssl; http2 on;/listen 443 ssl http2; listen [::]:443 ssl http2;/' "$CONF"
    fi
    nginx -t 2>&1 | tail -2; systemctl reload nginx
  }
  mkdir -p /var/www/html
  escrever_conf
  ok "nginx: $CONF"
  if [ ! -f "$CERT/fullchain.pem" ]; then
    if [ "$DNS_OK" -eq 1 ]; then
      command -v certbot >/dev/null 2>&1 || apt_instalar certbot
      if [ -n "$EMAIL" ]; then CB_MAIL=(-m "$EMAIL"); else CB_MAIL=(--register-unsafely-without-email); fi
      if certbot certonly --webroot -w /var/www/html -d "$DOMINIO" --non-interactive --agree-tos "${CB_MAIL[@]}" >/dev/null 2>&1; then
        escrever_conf; ok "HTTPS ativo (Let's Encrypt; renovação automática pelo certbot)"
      else av "Não consegui o certificado agora (o DNS propagou? a porta 80 está aberta?). Roda de novo no próximo push."; fi
    else av "Sem HTTPS por enquanto: o DNS de $DOMINIO ainda não aponta para esta VPS."; fi
  else ok "Certificado HTTPS já existente"; fi
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy 2>/dev/null && printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/recarregar-nginx.sh && chmod +x /etc/letsencrypt/renewal-hooks/deploy/recarregar-nginx.sh || true
else
  CF=/etc/caddy/Caddyfile; touch "$CF"
  sed -i '/# melodia-inicio/,/# melodia-fim/d' "$CF"
  printf '# melodia-inicio (gerado por deploy/vps-preparar.sh)\n%s {\n    reverse_proxy 127.0.0.1:%s\n}\n# melodia-fim\n' "$DOMINIO" "$PORTA" >> "$CF"
  caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1 && systemctl reload caddy
  ok "Caddy: $DOMINIO -> 127.0.0.1:$PORTA (o Caddy cuida do HTTPS sozinho)"
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ok "Firewall (ufw): 80 e 443 liberadas"; fi


# ---------- 5) HTTPS nos cookies, backup diário e conferência ----------
titulo "Ajustes finais"
if { [ -f "$CERT/fullchain.pem" ] || systemctl is-active --quiet caddy 2>/dev/null; } && [ "$(lerenv COOKIE_SECURE)" != "true" ]; then
  gravar COOKIE_SECURE true; systemctl restart melodia; sleep 2; ok "Cookies seguros ativados (HTTPS)"
fi
cat > /etc/cron.daily/melodia-backup <<CRON
#!/bin/sh
# Backup diário do banco do MelodIA (gerado por deploy/vps-preparar.sh). Mantém 14 dias.
cd "$APP_DIR" && runuser -u $APP_USER -- env DATA_DIR="$DATA_DIR" "$NODE_BIN" --disable-warning=ExperimentalWarning backup.js >/dev/null 2>&1
find "$DATA_DIR/backups" -name 'melodia-*.db' -mtime +14 -delete 2>/dev/null
CRON
chmod 755 /etc/cron.daily/melodia-backup
ok "Backup diário em $DATA_DIR/backups (14 dias)"
falhou=0
curl -fsS --max-time 10 "http://127.0.0.1:$PORTA/" >/dev/null && ok "app responde em 127.0.0.1:$PORTA" || { erro "app não responde em 127.0.0.1:$PORTA"; falhou=1; }
ST="$(curl -fsS --max-time 10 "http://127.0.0.1:$PORTA/api/status" || true)"
[ -n "$ST" ] && echo "$ST" || { erro "API não responde (journalctl -u melodia)"; falhou=1; }
if curl -fsS --max-time 15 "$URL/api/status" >/dev/null 2>&1; then ok "$URL no ar"
elif curl -fsS --max-time 15 -H "Host: $DOMINIO" "http://127.0.0.1/api/status" >/dev/null 2>&1; then av "O proxy funciona, mas $URL ainda não abre de fora (DNS/HTTPS)."
else av "$URL ainda não responde."; fi
if [ "$CANTO_OK" = 1 ]; then
  T0=$(date +%s%N); TD="$DATA_DIR/canto/autoteste"; mkdir -p "$TD" && chown -R "$APP_USER:$APP_USER" "$DATA_DIR/canto"
  RT="$(curl -fsS --max-time 240 -H 'Content-Type: application/json' -d '{"lines":[{"id":"lead","notes":[{"t":0,"d":1,"m":62,"s":"can","wi":true},{"t":1,"d":1,"m":64,"s":"ta","wf":true},{"t":2,"d":1,"m":67,"s":"a","wi":true,"wf":true},{"t":3,"d":1,"m":65,"s":"vi","wi":true},{"t":4,"d":2,"m":64,"s":"da","wf":true},{"t":6,"d":1,"m":62,"s":"sem","wi":true},{"t":7,"d":1,"m":64,"s":"pre","wf":true},{"t":8,"d":1,"m":65,"s":"quan","wi":true},{"t":9,"d":1,"m":64,"s":"do","wf":true},{"t":10,"d":1,"m":62,"s":"o","wi":true,"wf":true},{"t":11,"d":1,"m":60,"s":"co","wi":true},{"t":12,"d":1,"m":62,"s":"ra","wf":false},{"t":13,"d":1,"m":64,"s":"ção","wf":true},{"t":14,"d":1,"m":62,"s":"me","wi":true,"wf":true},{"t":15,"d":1,"m":60,"s":"le","wi":true},{"t":16,"d":3,"m":60,"s":"va","wf":true}]}],"bpm":96,"vd":{"vib":0.5},"voice":{"f":1},"seed":1,"outdir":"'"$TD"'","base":"autoteste"}' "http://127.0.0.1:$(lerenv CANTO_PORT)/render" || true)"
  if echo "$RT" | grep -q '"files"'; then ok "Autoteste do canto (\"canta a vida\") em $(( ($(date +%s%N)-T0)/1000000 )) ms: $RT"; else av "Autoteste do canto falhou: $RT"; journalctl -u melodia-canto -n 20 --no-pager || true; fi
  rm -rf "$TD"
  systemctl show melodia-canto -p MemoryCurrent | sed 's/MemoryCurrent=/Memória do canto: /'
fi
case "$ST" in *'"needsSetup":true'*) av "Ainda não há administrador: abra $URL AGORA e crie a conta de administrador (a 1ª conta criada vira admin)." ;; esac
[ "$falhou" -eq 0 ] || exit 1
ok "Pronto: $URL"
