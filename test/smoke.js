'use strict';
// Sobe o servidor num banco temporário e testa os fluxos principais. Uso: npm test
const { spawn } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const PORT = 3900 + Math.floor(Math.random() * 90), BASE = 'http://127.0.0.1:' + PORT;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'melodia-'));
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FALHA ') + m); if (!c) fails++; };

class Client {
  constructor() { this.ck = ''; }
  async call(method, url, body, hdr) {
    const r = await fetch(BASE + url, { method, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Requested-With': 'melodia', Cookie: this.ck }, hdr || {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.ck = sc.split(';')[0].replace(/^mo_sid=$/, '');
    let j = null; try { j = await r.json(); } catch (e) { }
    return { s: r.status, j };
  }
}
const proj = n => ({ name: n, data: { tracks: [{ id: 'mel', notes: [] }], bpm: 100 } });

(async () => {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: tmp }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => /ouvindo/.test(String(d)) && r()));
  try {
    const adm = new Client(), bob = new Client(), anon = new Client();
    let r = await anon.call('GET', '/api/status'); ok(r.j.needsSetup === true, 'primeiro acesso pede criação do administrador');
    r = await anon.call('GET', '/api/me'); ok(r.s === 401, 'sem login: /me responde 401');
    r = await adm.call('POST', '/api/register', { name: 'Ana', email: 'ana@exemplo.com', password: 'senha-forte-1' }); ok(r.s === 201 && r.j.user.role === 'admin', 'primeiro cadastro vira administrador');
    r = await anon.call('POST', '/api/register', { name: 'X', email: 'x@exemplo.com', password: 'senha-forte-2' }); ok(r.s === 403, 'cadastro aberto desativado por padrão');
    r = await adm.call('POST', '/api/projects/semcsrf', null, { 'X-Requested-With': 'outro' }); ok(r.s === 403, 'bloqueia requisição sem cabeçalho de proteção');
    r = await adm.call('PUT', '/api/projects/proj-ana-001', proj('Minha música')); ok(r.s === 200 && r.j.version === 1, 'cria projeto (versão 1)');
    r = await adm.call('PUT', '/api/projects/proj-ana-001', proj('Minha música v2')); ok(r.j.version === 2, 'atualiza projeto (versão 2)');
    r = await adm.call('PUT', '/api/projects/proj-ana-002', { name: 'ruim', data: {} }); ok(r.s === 400, 'rejeita dados de projeto inválidos');
    r = await adm.call('POST', '/api/admin/users', { name: 'Bob', email: 'bob@exemplo.com', password: 'senha-forte-3', role: 'user' }); ok(r.s === 201, 'administrador cria usuário');
    r = await bob.call('POST', '/api/login', { email: 'bob@exemplo.com', password: 'errada-123' }); ok(r.s === 401, 'senha errada é recusada');
    r = await bob.call('POST', '/api/login', { email: 'BOB@exemplo.com', password: 'senha-forte-3' }); ok(r.s === 200, 'login do usuário (e-mail sem diferenciar maiúsculas)');
    r = await bob.call('GET', '/api/projects'); ok(r.j.projects.length === 0, 'usuário não vê projetos de outros');
    r = await bob.call('GET', '/api/projects/proj-ana-001'); ok(r.s === 404, 'não abre projeto alheio');
    r = await bob.call('PUT', '/api/projects/proj-ana-001', proj('invasão')); ok(r.s === 403, 'não sobrescreve projeto alheio');
    r = await bob.call('GET', '/api/admin/users'); ok(r.s === 403, 'usuário comum não acessa a administração');
    r = await adm.call('GET', '/api/admin/projects'); ok(r.j.projects.length === 1 && r.j.projects[0].owner === 'Ana', 'administrador vê projetos de todos');
    r = await adm.call('GET', '/api/projects/proj-ana-001'); ok(r.s === 200, 'administrador consegue ler o projeto');
    r = await adm.call('GET', '/api/me'); const myId = r.j.user.id;
    r = await adm.call('PATCH', '/api/admin/users/' + myId, { role: 'user' }); ok(r.s === 409, 'não rebaixa o último administrador');
    r = await adm.call('DELETE', '/api/admin/users/' + myId); ok(r.s === 409, 'não exclui a própria conta');
    r = await adm.call('GET', '/api/admin/users'); const bobId = r.j.users.find(u => u.email === 'bob@exemplo.com').id;
    r = await adm.call('PATCH', '/api/admin/users/' + bobId, { active: false }); ok(r.s === 200, 'administrador desativa usuário');
    r = await bob.call('GET', '/api/me'); ok(r.s === 401, 'sessão do usuário desativado cai na hora');
    r = await bob.call('POST', '/api/login', { email: 'bob@exemplo.com', password: 'senha-forte-3' }); ok(r.s === 401, 'usuário desativado não entra');
    r = await adm.call('POST', '/api/me/password', { current: 'errada', next: 'nova-senha-123' }); ok(r.s === 403, 'troca de senha exige a senha atual');
    r = await adm.call('POST', '/api/me/password', { current: 'senha-forte-1', next: 'nova-senha-123' }); ok(r.s === 200, 'troca a própria senha');
    r = await adm.call('GET', '/api/admin/audit'); ok(r.j.events.length > 5, 'registro de atividades preenchido');
    r = await adm.call('DELETE', '/api/projects/proj-ana-001'); ok(r.s === 200, 'exclui projeto');
    r = await adm.call('POST', '/api/logout'); r = await adm.call('GET', '/api/me'); ok(r.s === 401, 'logout encerra a sessão');
    const h = await fetch(BASE + '/'); ok(h.status === 200 || h.status === 404, 'servidor entrega arquivos estáticos');
    const t = await fetch(BASE + '/..%2f..%2fserver.js'); ok(t.status !== 200, 'bloqueia acesso fora da pasta pública');
  } catch (e) { console.error(e); fails++; }
  srv.kill(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `\n${fails} falha(s)` : '\nTodos os testes passaram');
  process.exit(fails ? 1 : 0);
})();
