# MelodIA Orquestra — pacote 5: voz humanizada e mascote músico

App de orquestração com **contas de usuário**, **projetos salvos no servidor (SQLite)** e **painel de administração**.
Sem dependências para instalar: usa apenas o Node.js (versão 22.13 ou superior).

## Como iniciar

1. Instale o Node.js 22.13+ (https://nodejs.org).
2. Abra um terminal nesta pasta e rode:
   - Linux/macOS: `./start.sh`
   - Windows: dê dois cliques em `start.bat`
   - Qualquer sistema: `npm start`
3. Abra http://127.0.0.1:3000 no Chrome ou Edge.
4. **No primeiro acesso, crie a conta do administrador.** Ela é a primeira e a única que o app deixa criar sozinha.

Com Docker: `docker build -t melodia .` e `docker run -p 3000:3000 -v melodia-dados:/data melodia`.
Dentro de contêiner o servidor escuta em todas as interfaces: coloque um proxy com HTTPS na frente.

## Configuração (opcional)

Copie `.env.example` para `.env` e ajuste:

| Variável | Padrão | Para que serve |
|---|---|---|
| `PORT` | 3000 | Porta |
| `HOST` | 127.0.0.1 | `0.0.0.0` libera acesso pela rede |
| `DATA_DIR` | ./data | Onde fica o banco (`melodia.db`) |
| `SESSION_DAYS` | 7 | Validade do login |
| `ALLOW_SIGNUP` | false | `true` deixa qualquer pessoa criar conta |
| `COOKIE_SECURE` | false | Use `true` quando acessar por HTTPS |
| `MAX_BODY_MB` | 10 | Tamanho máximo de um projeto |

## Transcrição da letra no servidor (recomendado)

A letra da música é extraída por um serviço de transcrição de fala. O app tenta, nesta ordem: **servidor** → modelo Whisper no navegador → reconhecimento de fala do navegador.
Para ativar o servidor, crie uma chave **nova** no provedor (qualquer API compatível com `/v1/audio/transcriptions`, como a da OpenAI) e coloque em `.env`:

```
TRANSCRIBE_API_KEY=cole-aqui-a-chave-nova
# opcionais:
# TRANSCRIBE_URL=https://api.openai.com/v1/audio/transcriptions
# TRANSCRIBE_MODEL=whisper-1
# TRANSCRIBE_MAX_MB=25
```

A chave fica só no servidor e nunca chega ao navegador. O áudio enviado é só o trecho escolhido, em WAV mono de 16 kHz (cerca de 2 MB por minuto), e o limite é de 30 pedidos por usuário a cada 15 minutos. Use uma chave nova: qualquer chave que já tenha sido colada em conversa ou arquivo deve ser considerada comprometida.

## Usuários e permissões

- **Administrador**: cria, desativa, reativa, exclui usuários, redefine senhas, muda perfis, vê a lista de todos os projetos (e abre uma cópia na própria conta ou exclui) e consulta o registro de atividades. Tudo em **Conta → Administração**.
- **Usuário**: vê, cria, edita e exclui só os próprios projetos e altera a própria senha.
- O sistema nunca deixa a base sem administrador ativo, e ninguém exclui a própria conta.
- Os projetos são salvos automaticamente a cada edição. O navegador mantém uma cópia local por usuário, e o servidor é a fonte oficial.
- Se você já usava o app sem servidor, os projetos guardados no navegador são enviados à conta do administrador criada no primeiro acesso.

## Backup e restauração

- Backup: `npm run backup` (cria `data/backups/melodia-AAAAMMDD-HHMMSS.db`, com o servidor ligado ou não).
- Restaurar: pare o servidor e substitua `data/melodia.db` pelo arquivo de backup.
- Copie também a pasta `data/backups` para fora da máquina.

## Segurança

- Senhas guardadas com scrypt e sal individual; sessões por cookie `HttpOnly` + `SameSite=Strict`, com o token guardado apenas como hash.
- Proteção contra requisições forjadas (cabeçalho obrigatório + checagem de origem), limite de tentativas de login e cadastro, e mensagem de erro igual para e-mail ou senha errados.
- Para uso fora do seu computador: sirva por **HTTPS** (Caddy, Nginx ou similar), defina `COOKIE_SECURE=true` e mantenha `ALLOW_SIGNUP=false`.
- Este pacote **não contém nenhuma chave ou senha**. Não coloque chaves de API no código do navegador: quem abre a página consegue lê-las.

## IA no servidor (recomendado fora da plataforma)

Interpretar prompts de arranjo, recriar faixas, criar capas e letras usa IA. O app tenta, nesta ordem: IA da plataforma (quando existe) → **este servidor** → plano B local por palavras-chave (sempre funciona, com menos inteligência).
Para ativar no servidor, crie uma chave **nova** no provedor e coloque em `.env`:

```
AI_PROVIDER=anthropic        # ou openai
AI_API_KEY=cole-aqui-a-chave-nova
# opcionais: AI_MODEL=..., AI_URL=...
```

A chave fica só no servidor. Limite de 60 pedidos por usuário a cada 15 minutos. **Nunca cole chaves no código da página nem em conversas**: qualquer chave exposta deve ser revogada.

## Vozes, timbres e radIA

- **Vozes clonadas** e **timbres personalizados** ficam salvos na conta (tabela `userdata`) e acompanham o usuário em qualquer projeto e dispositivo. A primeira voz criada vira a padrão; o usuário pode trocar.
- A "clonagem" é **paramétrica**: o app mede altura, alcance, brilho, sopro e vibrato da amostra e ajusta o sintetizador de canto. Não é uma clonagem neural e não reproduz a voz com fidelidade.
- **radIA**: cada publicação guarda a composição (notas, instrumentos, timbre da voz e capa), não um arquivo de áudio; ela é sintetizada na hora para quem ouve. A rádio sorteia as publicações com mais chance para as mais próximas da antena (distância na superfície do globo). Autores e administradores podem excluir publicações (`DELETE /api/radia/:id`). Com menos de 10 publicações reais, o app completa a rádio com peças de demonstração.

## Voz humanizada (v5)

A faixa **Canto** agora canta a melodia da partitura com um motor humanizado, sem servidor nem rede neural (tudo é sintetizado no navegador, inclusive na exportação WAV e na radIA):

- **Canto por frases**, não nota a nota: a voz liga as notas como um cantor, com portamento, ataque vindo de baixo da nota (*scoop*), vibrato que entra depois do início da nota, pequenas oscilações naturais de afinação e volume e queda leve no fim das frases.
- **Timbre**: fonte glotal com brilho variável e cinco formantes por registro (baixo, tenor, contralto, soprano) escolhidos pela altura do cantor ou do perfil de voz clonado; vogais abertas e fechadas, nasais (ã, õ, -m, -n), ditongos e redução da vogal final do português (sempre → "sempri").
- **Consoantes do português**: oclusivas, fricativas, nasais, laterais e o "r" fraco, entrando um pouco antes do tempo para a vogal cair no tempo; "ti/di" palatalizados e "r" inicial aspirado.
- **Ritmo e nuances**: respirações audíveis entre frases, dinâmica que cresce e decresce na frase, acentos de compasso, articulação (legato, normal, staccato, marcato ou automática pelo ritmo do baixo), cantar adiantado ou atrasado e variação humana de tempo.
- **Integração com as outras faixas**: segunda voz em terças, quintas ou oitava (pela escala do tom detectado), dobras em uníssono, coro de apoio em "uuu/aaa" sobre os acordes da Harmonia, reverberação (estúdio, sala, igreja) e **espaço no mix**: harmonia, arpejo e o instrumento que dobra a melodia recuam quando a voz canta.

**Direção vocal** (passo 4 → *Interpretação humanizada da voz*):

- **Automática**: lida do estilo, do andamento, do prompt de arranjo (passo 2 ou boas-vindas) e da descrição da voz. Ex.: "jazz noturno… voz grave rouca" já canta atrás do tempo, com mais portamento e voz rouca.
- **Personalizada**: escreva um prompt ("balada íntima em legato, vibrato tardio, respiração audível, segunda voz em terças, sala"). Ele é interpretado pela IA quando disponível (plataforma ou `AI_API_KEY` no servidor) e sempre por um plano B local por palavras-chave.
- **Ajuste fino**: 17 controles e 5 seletores (vibrato, portamento, sopro, respirações, expressão, dicção, brilho, reverberação, coro, segunda voz, motor clássico…). Os ajustes valem nos dois modos e ficam salvos no projeto; **Restaurar automático** limpa tudo.
- A interpretação acompanha o projeto (servidor, .json) e as publicações da radIA.

## Mascote músico e ícones animados (v5)

- Um **palco** no topo da área principal traz o mascote em versão músico: ele respira, pisca, segue o ponteiro com os olhos e faz *squash & stretch* ao pular.
- **Toca o instrumento da faixa selecionada** (batuta de maestro, microfone, violino, teclado, baquetas, flauta, baixo ou fones para faixas de áudio), ou o papel fixo escolhido em *Papel do mascote*.
- Durante a reprodução, **rege no compasso** (desenho de 4 tempos), toca no ritmo e **faz sincronia labial com a voz**: abre o bico conforme a vogal e o volume real da faixa de canto, ergue as sobrancelhas nas notas agudas e fecha os olhos nas notas longas. O balão vira um **karaokê** com a sílaba cantada em destaque.
- O balão repete as mensagens do app com expressão (alegre, pensativo, preocupado, comemorando). Clicar no mascote faz ele cantar uma frase com a voz e a interpretação atuais.
- **Ícones animados** com volume e brilho (estilo animação 3D) nos passos, nas faixas e na barra de ações rápidas (Tocar, Gerar voz, Voz + banda, Direção vocal, Reorquestrar, Exportar). Tudo respeita a opção do sistema de reduzir movimento.

## Aprender a tocar (passo 6)

Transforma a música processada em material de estudo para o instrumento escolhido:

- **Instrumentos (15):** piano, teclado/órgão, violão, guitarra, cavaquinho, ukulele, baixo elétrico, violino, violoncelo, flauta, clarinete em Si♭, sax alto em Mi♭, trompete em Si♭, voz e marimba. Cada um com a extensão real, a escrita transposta (clarinete, sax, trompete, violão/guitarra/baixo uma oitava acima), tablatura com dedilhado otimizado e diagramas de acordes para os instrumentos com trastes, dedilhado no piano, arcadas no arco e respirações no sopro e na voz.
- **O que tocar:** melodia, canto (com letra), 2ª voz, baixo, harmonia, arpejo, ou **melodia + acompanhamento** (piano: mão esquerda no estilo; violão e cavaquinho: levada com acordes).
- **Contexto da harmonia:** você escolhe as vozes que definem os acordes (baixo, harmonia, melodia, canto, 2ª voz, arpejo) e o ritmo harmônico. As cifras são analisadas por compasso ou meio compasso, com prioridade para o baixo, e enriquecidas conforme o estilo e o nível (7ª e 9ª no jazz e na bossa só quando a 9ª pertence ao tom, V7 nas cadências clássicas, add9 no cinematográfico). Instrumentos transpositores recebem as cifras já transpostas.
- **Estudos:** arranjo da música; aquecimento (escala e arpejos de I, IV, V e I); **ornamentos** idiomáticos (trinado, mordente, grupeto e apojatura no clássico; envolvimento, scoop, fall e nota fantasma no jazz; bend, slide e ligados H/P no blues); **melismas** (diminuições em graus conjuntos no clássico, runs pentatônicos no gospel/pop, blue note no blues, escala bebop no jazz); **solo/improviso** (notas do acorde nos tempos fortes, notas-guia, motivo em pergunta e resposta); **acompanhamento** (baixo de Alberti, notas-guia, levada de bossa, arpejo p-i-m-a). Cada estudo traz "Como estudar" e "Base na literatura" (C. P. E. Bach, Quantz, Leopold Mozart, Ortiz, Caccini, García, Levine, Coker, Baker, Crook, Chediak).
- **Prompt:** indicações livres ("solo de jazz de 8 compassos com notas-guia, avançado", "ornamentos barrocos nos compassos 1 a 8"), interpretadas pela IA quando disponível e sempre por uma leitura local; a IA pode acrescentar dicas de estudo.
- **Prática:** toca o estudo com a banda completa, só com as vozes de contexto, só com metrônomo ou sozinho; andamento de 40% a 120%, trecho de compassos em repetição, contagem de um compasso e as notas acendendo na partitura. Exporta o MIDI do estudo ou adiciona o estudo como faixa do projeto.

## Canto natural no servidor (v6)

A faixa **Canto** pode ser gerada no servidor com uma **voz neural de verdade**, que soa como canto humano compreensível e não como síntese de formantes:

1. **Voz neural Piper** (`pt_BR-faber-medium`, licença MIT, ONNX, sem PyTorch) lê a letra e devolve a duração de cada fonema.
2. Cada sílaba é separada em **consoante inicial, vogal e consoante final**. As consoantes mantêm o tempo natural e entram um pouco antes do tempo; a vogal é esticada até o fim da nota (melismas incluídos).
3. O vocoder **WORLD** (`pyworld`) reafina tudo na partitura, com a direção vocal do passo 4: portamento, *scoop*, vibrato tardio, deriva natural, queda no fim das frases, dinâmica de frase, brilho, sopro, anel lírico, respirações entre frases e articulação (legato, staccato, marcato).
4. **Timbre:** sem voz importada, usa a voz padrão ajustada ao registro (feminina, masculina ou infantil, pelos formantes). Com uma voz importada em *Vozes*, a amostra (até 25 s) é guardada no servidor e o canto é aproximado desse timbre (formantes + equalização espectral).
5. **GPU externa opcional (Seed-VC):** com `CANTO_GPU=hf` (Space do Hugging Face, `HF_TOKEN` opcional) ou `CANTO_GPU=replicate` (`REPLICATE_API_TOKEN`, `CANTO_GPU_REPLICATE_VERSION`, `CANTO_GPU_REPLICATE_INPUT`) no segredo `MELODIA_ENV`, e o controle *Timbre na GPU externa* = 1, o canto já afinado é convertido para o timbre da amostra por conversão de canto *zero-shot*. Se a GPU falhar, fica a versão WORLD.

No app: passo 4 → **🎙 Gerar canto natural** (é disparado sozinho depois de *Gerar voz na melodia*). O resultado fica em cache no servidor; se letra, notas, voz ou interpretação mudarem, o app avisa que está desatualizado e, até gerar de novo, a voz do navegador canta. A segunda voz também é cantada pela voz neural; dobras e coro de apoio continuam no navegador. O canto natural vai junto na exportação WAV e nas publicações da radIA.

Na VPS, o deploy instala tudo sozinho: Python isolado em `/opt/melodia-canto/venv`, a voz em `/var/lib/melodia/canto-modelos` e o serviço `melodia-canto`, que só escuta em 127.0.0.1, roda com prioridade baixa e tem teto de 800 MB de memória para não afetar os outros apps. Se a instalação falhar, o site segue com a voz do navegador. O log de cada publicação traz um autoteste ("canta a vida") com o tempo de geração.

## Canto alinhado: letra, ornamentos e efeitos vocais (v9)

Quando a gravação é **voz cantada** (opção marcada por padrão no passo 1) e o canto natural está instalado no servidor, a análise do trecho é feita em `canto/transcricao.py`:

1. **Altura** com Harvest (WORLD) a cada 10 ms, com correção de oitava contra a mediana móvel. Isso elimina as notas graves falsas da análise do navegador.
2. **Sílabas cantadas**: trechos sonoros são divididos nos vales de energia. Cada um é uma sílaba ou um efeito.
3. **Notas e ornamentos** dentro de cada sílaba: platôs de altura viram notas. Deslizes de entrada (scoop), quedas, vibrato e apojaturas com menos de 80 ms ficam como ornamento da nota vizinha e não roubam sílaba.
4. **Letra no tempo** com Whisper local (`faster-whisper`, CPU int8, modelo `CANTO_ASR_MODEL`, padrão `base`). Cada palavra cai nas sílabas cantadas do seu intervalo. Uma sílaba que continua em outra altura é **melisma**, e um som sem palavra é **efeito vocal** (`ô`, `ê`, `tá`, `hm`).
5. **IA de contexto** (opcional, usa a mesma IA do app: `AI_PROVIDER`/`AI_API_KEY`): revisa por frases onde é pronúncia de sílaba, melisma, ornamento ou efeito rítmico vocal e corrige sílabas mal reconhecidas. Uma trava desfaz o trecho se a IA apagar sílabas da letra. Botão **🧠 Realinhar letra com IA** no passo 4.

A faixa **Canto** usa o tempo de cada sílaba em vez de distribuir a letra em sequência, e transpõe só por oitavas inteiras. Letra digitada ou gerada depois também é encaixada nas sílabas cantadas detectadas. Sem o serviço, o app volta para a análise do navegador.

Rota: `POST /api/canto/transcrever` (WAV mono 16 kHz no corpo; `/sem-letra` pula o Whisper) → trabalho na fila do canto, acompanhado em `GET /api/canto/jobs/:id`.

## Publicação automática na VPS (melodia.m3d.pro)

Mesmo modelo do **appet** e do **revalida**: a cada push na `main`, o GitHub Actions roda os testes, copia o app para `/opt/melodia` na VPS e executa `deploy/vps-preparar.sh`.

- **1ª vez:** garante o Node 22.13+ só para este app (em `/opt/melodia-node`, sem mexer no Node dos outros apps), escolhe uma porta livre a partir de **3200** (só escuta em 127.0.0.1), cria o serviço `melodia`, configura o proxy reverso `melodia.m3d.pro` (usa o nginx ou o Caddy que já estiverem na VPS, sem tocar nos outros sites), emite o HTTPS e ativa o backup diário do banco.
- **Depois:** roda o teste de fumaça na própria VPS (se falhar, a versão anterior continua no ar), reinicia e confere `/api/status`.
- O banco fica em `/var/lib/melodia` (fora da pasta atualizada), com cópias diárias em `/var/lib/melodia/backups` (14 dias).

### Configurar (uma vez)
1. **DNS:** registro **A** `melodia` → `159.223.22.82` no domínio `m3d.pro`.
2. **GitHub → Settings → Secrets and variables → Actions → New repository secret:**
   - `VPS_SSH_KEY`: a mesma chave privada SSH do appet/revalida (acesso root à VPS).
   - `MELODIA_ENV` *(opcional)*: o conteúdo do `.env` de produção (chaves de IA/transcrição, `ALLOW_SIGNUP`…). `PORT`, `HOST`, `DATA_DIR`, `TRUST_PROXY` e `COOKIE_SECURE` são definidos pelo script.
3. **Actions → Publicar na VPS → Run workflow** (ou faça qualquer push na `main`).
4. **Logo após a 1ª publicação, abra https://melodia.m3d.pro e crie a conta de administrador:** a primeira conta criada vira admin.

Padrões (mude em *Variables* se precisar): `VPS_HOST=159.223.22.82`, `VPS_USER=root`, `VPS_PORT=22`, `VPS_DIR=/opt/melodia`, `DOMINIO_MELODIA=melodia.m3d.pro`, `EMAIL_CERT`.

### Trocar chaves depois
Atualize o segredo `MELODIA_ENV` no GitHub e rode o workflow, ou, com o GitHub CLI: `bash deploy/set-keys.sh`.

### Na VPS
```bash
systemctl status melodia            # estado
journalctl -u melodia -f            # logs
cd /opt/melodia && bash deploy/vps-preparar.sh --dominio melodia.m3d.pro   # reinstalar/atualizar à mão
```

## Diagnóstico e acompanhamento

Ao enviar um áudio, o app mostra cada etapa com porcentagem e tempo gasto (recepção, decodificação, verificação do sinal, análise de frequências, vozes, notas, andamento, orquestra, partitura e letra), marca as que falharam em vermelho e explica o motivo. O botão **Verificar problemas** confere o arquivo (volume, silêncio, saturação, duração) e o ambiente (Web Audio, microfone, reconhecimento de fala, transcrição no servidor). A análise começa sozinha ao carregar o áudio; isso pode ser desligado em Configurações.

## Teste

`npm test` sobe o servidor num banco temporário e verifica 48 fluxos, incluindo a transcrição com um provedor simulado,: primeiro acesso, login, permissões entre usuários, administração, proteção do último administrador, troca de senha, sair de todos os dispositivos e logout.

## Limites

- SQLite atende bem uma equipe pequena num único servidor. Para muitos usuários simultâneos, migre para PostgreSQL.
- O banco guarda notas, faixas, letras e ajustes. **O áudio original não é guardado.**
- A transcrição de letra (Whisper) baixa o modelo de um CDN na primeira vez e exige internet no navegador de quem usa.
- Sem chave de transcrição no servidor, a letra depende do Whisper no navegador (baixa um modelo de cerca de 75 MB na primeira vez) ou do reconhecimento de fala do Chrome/Edge.
- Importar partitura em PDF só funciona para PDFs exportados pelo próprio MelodIA (eles carregam as notas embutidas). Partituras escaneadas ou de outros programas exigem reconhecimento óptico de música; exporte MIDI no programa de origem.
- O PDF usa uma biblioteca carregada de CDN e também precisa de internet.

## Estrutura

```
server.js      servidor (API + arquivos estáticos)
schema.sql     tabelas: users, sessions, projects, audit
public/        o app (index.html)
backup.js      cópia consistente do banco
test/smoke.js  teste automático da API
```

## API (resumo)

`GET /api/status` · `POST /api/register|login|logout` · `GET /api/me` · `POST /api/me/password` · `POST /api/me/logout-all` · `POST /api/transcribe` (corpo WAV)
`GET /api/projects[?full=1]` · `GET|PUT|DELETE /api/projects/:id`
`GET|PUT|DELETE /api/userdata/:chave` · `POST /api/ai` · `GET|POST /api/radia` · `GET|DELETE /api/radia/:id` · `GET|POST /api/admin/users` · `PATCH|DELETE /api/admin/users/:id` · `GET /api/admin/projects` · `GET /api/admin/audit`
Toda requisição que não seja GET precisa do cabeçalho `X-Requested-With: melodia`.
