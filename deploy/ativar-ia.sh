#!/usr/bin/env bash
# MelodIA · ativa a IA no servidor com failsafe (Claude → Gemini → OpenAI → Pollinations).
# Rode NA VPS, como root:   sudo bash /opt/melodia/deploy/ativar-ia.sh
# O script pede cada chave sem mostrar na tela (Enter = pular / manter a atual), testa cada uma,
# grava só no .env da VPS (permissão 600, fora do Git) e reinicia o app.
# Se um provedor falhar depois (cota, chave revogada), o app passa sozinho para o próximo da fila.
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/melodia}"; ENVC="$APP_DIR/.env"
[ "$(id -u)" = 0 ] || { echo "Rode como root: sudo bash $0"; exit 1; }
[ -d "$APP_DIR" ] || { echo "Pasta do app não encontrada: $APP_DIR (use APP_DIR=/caminho sudo -E bash $0)"; exit 1; }
command -v curl >/dev/null || apt-get install -y -qq curl
touch "$ENVC"; chmod 600 "$ENVC"
V='\033[32m✔\033[0m'; X='\033[31m✘\033[0m'
lerenv(){ { grep -E "^$1=" "$ENVC" 2>/dev/null || true; } | tail -1 | cut -d= -f2-; }
gravar(){ local t; t="$(mktemp)"; grep -vE "^$1=" "$ENVC" > "$t" || true; printf '%s=%s\n' "$1" "$2" >> "$t"; cat "$t" > "$ENVC"; rm -f "$t"; }
pedir(){ # $1 variável · $2 descrição. Aceita valor já exportado no ambiente.
  local atual="${!1:-$(lerenv "$1")}" v=""
  if [ -n "${!1:-}" ]; then printf '%s\n' "${!1}"; return; fi
  printf '%s %s: ' "$2" "$([ -n "$atual" ] && echo "[Enter mantém a atual …${atual: -4}]" || echo "[Enter pula]")" >&2
  read -rs v || true; echo >&2
  printf '%s\n' "${v:-$atual}" | tr -d '\r[:space:]'
}
codigo(){ local c; rm -f /tmp/melodia-ia.json; c="$(curl -s -o /tmp/melodia-ia.json -w '%{http_code}' --max-time 40 "$@" || true)"; echo "${c:-000}"; }
motivo(){ head -c 220 /tmp/melodia-ia.json 2>/dev/null | tr '\n' ' '; }

echo "== Chaves de IA (o texto digitado não aparece) =="
ANT="$(pedir ANTHROPIC_API_KEY 'Claude / Anthropic (sk-ant-api…)')"
GEM="$(pedir GEMINI_API_KEY 'Gemini (AIza…)')"
GOO="$(pedir GOOGLE_API_KEY 'Google, reserva do Gemini (AIza…)')"
GEC="$(pedir GEMINI_CURL_API_KEY 'Gemini, 2ª reserva (AQ.…)')"
OAI="$(pedir OPENAI_API_KEY 'OpenAI (sk-proj…; também ativa a transcrição de letra)')"
POL="$(pedir POLLINATIONS_API_KEY 'Pollinations (sk_…)')"
P='{"model":"MOD","max_tokens":8,"messages":[{"role":"user","content":"Responda só: ok"}]}'
G='{"contents":[{"parts":[{"text":"Responda só: ok"}]}],"generationConfig":{"maxOutputTokens":8,"thinkingConfig":{"thinkingBudget":0}}}'
ORDEM=(); SALVAR=()

echo; echo "== Testando =="
testar(){ # $1 nome · $2 variável · $3 valor · $4 grupo da fila · $5 código HTTP
  local nome="$1" var="$2" val="$3" grupo="$4" c="$5"
  [ -n "$val" ] || { echo "  · $nome: sem chave"; return; }
  if [ "$c" = 200 ]; then echo -e "  $V $nome respondeu"; SALVAR+=("$var=$val"); [[ " ${ORDEM[*]} " == *" $grupo "* ]] || ORDEM+=("$grupo")
  else echo -e "  $X $nome falhou (HTTP $c): $(motivo)"
    { read -rp "     Guardar mesmo assim como reserva? [s/N] " r </dev/tty; } 2>/dev/null || r=n
    [[ "$r" =~ ^[sS] ]] && SALVAR+=("$var=$val") || true
  fi
}
c=; [ -n "$ANT" ] && c=$(codigo https://api.anthropic.com/v1/messages -H "x-api-key: $ANT" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d "${P/MOD/claude-haiku-5-5}")
testar "Claude" ANTHROPIC_API_KEY "$ANT" anthropic "$c"
for par in "GEMINI_API_KEY:$GEM" "GOOGLE_API_KEY:$GOO" "GEMINI_CURL_API_KEY:$GEC"; do
  var="${par%%:*}"; val="${par#*:}"; c=
  [ -n "$val" ] && c=$(codigo "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent" -H "x-goog-api-key: $val" -H 'content-type: application/json' -d "$G")
  testar "Gemini ($var)" "$var" "$val" gemini "$c"
done
c=; [ -n "$OAI" ] && c=$(codigo https://api.openai.com/v1/chat/completions -H "Authorization: Bearer $OAI" -H 'content-type: application/json' -d "${P/MOD/gpt-4o-mini}")
testar "OpenAI" OPENAI_API_KEY "$OAI" openai "$c"
c=; [ -n "$POL" ] && c=$(codigo https://gen.pollinations.ai/v1/chat/completions -H "Authorization: Bearer $POL" -H 'content-type: application/json' -d "${P/MOD/openai}")
testar "Pollinations" POLLINATIONS_API_KEY "$POL" pollinations "$c"
rm -f /tmp/melodia-ia.json

[ ${#SALVAR[@]} -gt 0 ] || { echo; echo "Nenhuma chave para gravar. Nada foi alterado."; exit 1; }
# os que responderam vão à frente; os demais grupos com chave guardada ficam no fim como reserva
for g in anthropic gemini openai pollinations; do [[ " ${ORDEM[*]} " == *" $g "* ]] || ORDEM+=("$g"); done
cp "$ENVC" "$ENVC.antes-ia.$(date +%Y%m%d%H%M%S)"; chmod 600 "$ENVC".antes-ia.*
for kv in "${SALVAR[@]}"; do gravar "${kv%%=*}" "${kv#*=}"; done
gravar AI_ORDER "$(IFS=,; echo "${ORDEM[*]}")"
U="$(systemctl show melodia -p User --value 2>/dev/null || true)"; [ -n "$U" ] && chown "$U:$U" "$ENVC" || true
chmod 600 "$ENVC"

echo; echo "== Reiniciando o app =="
systemctl restart melodia; sleep 3
PORTA="$(lerenv PORT)"; ST="$(curl -fsS --max-time 10 "http://127.0.0.1:${PORTA:-3200}/api/status" || true)"
echo "$ST"
case "$ST" in *'"ai":true'*) echo -e "$V IA ativa. Ordem do failsafe: $(lerenv AI_ORDER)";; *) echo -e "$X O app não confirmou a IA. Veja: journalctl -u melodia -n 30"; exit 1;; esac
