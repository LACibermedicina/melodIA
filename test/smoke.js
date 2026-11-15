'use strict';
// Sobe o servidor num banco temporário e testa os fluxos principais. Uso: npm test
const { spawn } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http');
const PORT = 3900 + Math.floor(Math.random() * 90), BASE = 'http://127.0.0.1:' + PORT;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'melodia-'));
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FALHA ') + m); if (!c) fails++; };

class Client {
  constructor() { this.ck = ''; }
  async call(method, url, body, hdr) {
    const r = await fetch(BASE + url, { method, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Requested-With': 'melodia', Cookie: this.ck }, hdr || {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) { this.ck = sc.split(';')[0]; this.ck_full = this.ck; }
    let j = null; try { j = await r.json(); } catch (e) { }
    return { s: r.status, j };
  }
}
const proj = n => ({ name: n, data: { tracks: [{ id: 'mel', notes: [] }], bpm: 100 } });

(async () => {
  let seen = null;
  const mock = http.createServer((q, r) => { const c = []; q.on('data', d => c.push(d)); q.on('end', () => { seen = { auth: q.headers.authorization, ct: q.headers['content-type'], body: Buffer.concat(c).toString('latin1') }; r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify({ text: 'letra de teste da música' })); }); });
  let aiSeen = null;
  const mockAi = http.createServer((q, r) => { const c = []; q.on('data', d => c.push(d)); q.on('end', () => { aiSeen = { key: q.headers['x-api-key'], body: JSON.parse(Buffer.concat(c).toString()) }; r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify({ content: [{ type: 'text', text: '{"style":"jazz"}' }] })); }); });
  await new Promise(r => mockAi.listen(0, '127.0.0.1', r));
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: tmp, TRANSCRIBE_API_KEY: 'chave-de-teste', ANTHROPIC_API_KEY: 'chave-ia-teste', AI_URL: 'http://127.0.0.1:' + mockAi.address().port + '/v1/messages', TRANSCRIBE_URL: 'http://127.0.0.1:' + mock.address().port + '/v1/audio/transcriptions' }, stdio: ['ignore', 'pipe', 'inherit'] });
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
    r = await anon.call('GET', '/api/status'); ok(r.j.transcribe === true, 'status informa que a transcrição no servidor está ativa');
    const wavLike = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(2000, 1)]);
    let tr = await fetch(BASE + '/api/transcribe', { method: 'POST', headers: { 'X-Requested-With': 'melodia', 'Content-Type': 'audio/wav' }, body: wavLike }); ok(tr.status === 401, 'transcrição exige login');
    const stray = new Client(); r = await stray.call('POST', '/api/login', { email: 'ana@exemplo.com', password: 'nova-senha-123' }); ok(r.s === 200, 'login com a senha nova');
    tr = await fetch(BASE + '/api/transcribe', { method: 'POST', headers: { 'X-Requested-With': 'melodia', 'Content-Type': 'audio/wav', Cookie: stray.ck_full }, body: wavLike });
    const tj = await tr.json(); ok(tr.status === 200 && tj.text === 'letra de teste da música', 'transcrição passa pelo servidor e devolve o texto');
    ok(seen && seen.auth === 'Bearer chave-de-teste' && /name="model"/.test(seen.body) && /name="language"/.test(seen.body) && /multipart\/form-data; boundary=/.test(seen.ct), 'a chave fica só no servidor e o pedido ao provedor é multipart correto');
    tr = await fetch(BASE + '/api/transcribe', { method: 'POST', headers: { 'X-Requested-With': 'melodia', 'Content-Type': 'audio/wav', Cookie: stray.ck_full }, body: Buffer.from('nao e wav') }); ok(tr.status === 400, 'rejeita arquivo que não é WAV');
    r = await stray.call('POST', '/api/me/logout-all'); r = await stray.call('GET', '/api/me'); ok(r.s === 401, 'sair de todos os dispositivos encerra as sessões');
    r = await stray.call('POST', '/api/login', { email: 'ana@exemplo.com', password: 'nova-senha-123' });
    r = await stray.call('PUT', '/api/userdata/voices', { value: { list: [{ id: 'v1', name: 'Minha voz' }], def: 'v1' } }); ok(r.s === 200, 'salva dados do usuário (vozes)');
    r = await stray.call('GET', '/api/userdata/voices'); ok(r.j.value && r.j.value.def === 'v1', 'lê dados do usuário');
    r = await bob.call('GET', '/api/userdata/voices'); ok(r.s === 401, 'dados do usuário exigem login');
    r = await stray.call('PUT', '/api/userdata/CHAVE RUIM', { value: 1 }); ok(r.s === 400 || r.s === 404, 'rejeita chave inválida');
    r = await stray.call('POST', '/api/ai', { prompt: 'monte um arranjo de jazz', system: 'responda em JSON' }); ok(r.s === 200 && r.j.text === '{"style":"jazz"}', 'proxy de IA devolve o texto do provedor');
    ok(aiSeen && aiSeen.key === 'chave-ia-teste' && aiSeen.body.messages[0].content === 'monte um arranjo de jazz', 'a chave de IA fica só no servidor');
    r = await anon.call('POST', '/api/ai', { prompt: 'oi' }); ok(r.s === 401, 'IA exige login');
    r = await stray.call('POST', '/api/radia', { title: 'Aurora', desc: 'teste', lat: -23.5, lon: -46.6, data: { tracks: [{ notes: [] }], bpm: 100, cover: 'data:image/jpeg;base64,AAA' } }); ok(r.s === 201, 'publica na radIA');
    const rid = r.j.id;
    r = await stray.call('POST', '/api/radia', { title: 'Longe', desc: '', lat: 35.7, lon: 139.7, data: { tracks: [{ notes: [] }] } });
    r = await stray.call('GET', '/api/radia?lat=-22.9&lon=-43.2'); ok(r.j.posts.length === 2 && r.j.posts[0].title === 'Aurora' && r.j.posts[0].dist_km < r.j.posts[1].dist_km && r.j.posts[0].mine === true, 'radIA lista por proximidade da antena');
    r = await stray.call('POST', '/api/radia', { title: 'x', lat: 120, lon: 0, data: { tracks: [] } }); ok(r.s === 400, 'rejeita posição inválida');
    r = await stray.call('GET', '/api/radia/' + rid); ok(r.s === 200 && r.j.post.data.tracks.length === 1, 'abre uma publicação');
    const other = new Client(); await other.call('POST', '/api/login', { email: 'ana@exemplo.com', password: 'nova-senha-123' });
    r = await stray.call('DELETE', '/api/radia/' + rid); ok(r.s === 200, 'dono exclui a própria publicação');
    r = await adm.call('POST', '/api/logout'); r = await adm.call('GET', '/api/me'); ok(r.s === 401, 'logout encerra a sessão');
    const h = await fetch(BASE + '/'); ok(h.status === 200 || h.status === 404, 'servidor entrega arquivos estáticos');
    const t = await fetch(BASE + '/..%2f..%2fserver.js'); ok(t.status !== 200, 'bloqueia acesso fora da pasta pública');
  } catch (e) { console.error(e); fails++; }
  srv.kill(); mock.close(); mockAi.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `\n${fails} falha(s)` : '\nTodos os testes passaram');
  process.exit(fails ? 1 : 0);
})();
