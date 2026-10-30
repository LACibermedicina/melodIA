# MelodIA Orquestra — pacote com banco de dados e gestão de usuários

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

## Teste

`npm test` sobe o servidor num banco temporário e verifica 29 fluxos: primeiro acesso, login, permissões entre usuários, administração, proteção do último administrador, troca de senha e logout.

## Limites

- SQLite atende bem uma equipe pequena num único servidor. Para muitos usuários simultâneos, migre para PostgreSQL.
- O banco guarda notas, faixas, letras e ajustes. **O áudio original não é guardado.**
- A transcrição de letra (Whisper) baixa o modelo de um CDN na primeira vez e exige internet no navegador de quem usa.
- Os botões "Letra com IA" e "Refinar sílabas com IA" só funcionam na plataforma onde o app foi criado; neste pacote, use a letra padrão ou digite a letra.
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

`GET /api/status` · `POST /api/register|login|logout` · `GET /api/me` · `POST /api/me/password`
`GET /api/projects[?full=1]` · `GET|PUT|DELETE /api/projects/:id`
`GET|POST /api/admin/users` · `PATCH|DELETE /api/admin/users/:id` · `GET /api/admin/projects` · `GET /api/admin/audit`
Toda requisição que não seja GET precisa do cabeçalho `X-Requested-With: melodia`.
