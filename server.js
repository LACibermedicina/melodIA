'use strict';
/* MelodIA Orquestra: servidor com contas de usuário e banco de projetos.
   Sem dependências: usa apenas módulos nativos do Node (>= 22.13), incluindo node:sqlite. */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const scrypt = promisify(crypto.scrypt), env = process.env;

const CFG = {
  port: +env.PORT || 3000,
  host: env.HOST || '127.0.0.1',
  data: env.DATA_DIR || path.join(__dirname, 'data'),
  days: +env.SESSION_DAYS || 7,
  signup: env.ALLOW_SIGNUP === 'true',
  secure: env.COOKIE_SECURE === 'true',
  maxBody: (+env.MAX_BODY_MB || 10) * 1048576
};
const PUB = path.join(__dirname, 'public');
fs.mkdirSync(CFG.data, { recursive: true });
const db = new DatabaseSync(path.join(CFG.data, 'melodia.db'));
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
const Q = sql => db.prepare(sql);

/* ---------- utilidades ---------- */
const bad = (code, msg) => Object.assign(new Error(msg), { http: code });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const pub = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
function send(res, code, obj, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((ok, ko) => {
    let n = 0, dead = false; const c = [];
    req.on('data', d => { if (dead) return; n += d.length; if (n > CFG.maxBody) { dead = true; ko(bad(413, 'Conteúdo grande demais')); return; } c.push(d); });
    req.on('end', () => {
      if (dead) return;
      if (!c.length) return ok({});
      try { const j = JSON.parse(Buffer.concat(c).toString('utf8')); ok(j && typeof j === 'object' ? j : {}); }
      catch (e) { ko(bad(400, 'JSON inválido')); }
    });
    req.on('error', ko);
  });
}
function cookie(req, name) {
  for (const p of (req.headers.cookie || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i).trim() === name) { try { return decodeURIComponent(p.slice(i + 1).trim()); } catch (e) { return ''; } }
  }
  return '';
}
const audit = (uid, action, detail) => Q('INSERT INTO audit(user_id,action,detail) VALUES(?,?,?)').run(uid ?? null, action, detail ? String(detail).slice(0, 300) : null);

/* ---------- senhas, sessões e limite de tentativas ---------- */
async function hashPw(pw) {
  const salt = crypto.randomBytes(16), key = await scrypt(pw, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + key.toString('hex');
}
const DUMMY = 'scrypt$' + '00'.repeat(16) + '$' + '00'.repeat(64);
async function checkPw(pw, stored) {
  const [t, s, k] = String(stored).split('$');
  if (t !== 'scrypt') return false;
  const key = await scrypt(pw, Buffer.from(s, 'hex'), 64), exp = Buffer.from(k, 'hex');
  return key.length === exp.length && crypto.timingSafeEqual(key, exp);
}
function startSession(res, userId, ip) {
  const token = crypto.randomBytes(32).toString('hex');
  Q('INSERT INTO sessions(token_hash,user_id,expires_at,ip) VALUES(?,?,?,?)').run(sha(token), userId, Date.now() + CFG.days * 864e5, ip || null);
  return 'mo_sid=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + CFG.days * 86400 + (CFG.secure ? '; Secure' : '');
}
function auth(req) {
  const t = cookie(req, 'mo_sid'); if (!t) return null;
  const r = Q('SELECT u.id,u.name,u.email,u.role,u.active,s.token_hash th,s.expires_at ex FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(sha(t));
  return r && r.active && r.ex > Date.now() ? r : null;
}
const tries = new Map();
function limit(key) {
  const now = Date.now(), a = (tries.get(key) || []).filter(t => now - t < 15 * 60e3);
  if (a.length >= 8) throw bad(429, 'Muitas tentativas. Aguarde alguns minutos.');
  a.push(now); tries.set(key, a);
}
setInterval(() => { Q('DELETE FROM sessions WHERE expires_at<?').run(Date.now()); tries.clear(); }, 3600e3).unref();
Q('DELETE FROM sessions WHERE expires_at<?').run(Date.now());

/* ---------- validação ---------- */
function cleanName(v) { const s = String(v ?? '').trim(); if (!s || s.length > 80) throw bad(400, 'Informe um nome de até 80 caracteres'); return s; }
function cleanEmail(v) { const s = String(v ?? '').trim().toLowerCase(); if (s.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw bad(400, 'E-mail inválido'); return s; }
function cleanPw(v) { const s = String(v ?? ''); if (s.length < 8 || s.length > 200) throw bad(400, 'A senha deve ter de 8 a 200 caracteres'); return s; }
async function createUser(b, role) {
  const name = cleanName(b.name), email = cleanEmail(b.email), pw = cleanPw(b.password);
  if (Q('SELECT 1 x FROM users WHERE email=?').get(email)) throw bad(409, 'Este e-mail já está cadastrado');
  const r = Q('INSERT INTO users(name,email,pass_hash,role) VALUES(?,?,?,?)').run(name, email, await hashPw(pw), role);
  return Q('SELECT id,name,email,role FROM users WHERE id=?').get(Number(r.lastInsertRowid));
}
const PID = /^[A-Za-z0-9_-]{6,64}$/;

/* ---------- API ---------- */
async function api(req, res, u, p) {
  const m = req.method;
  if (m !== 'GET' && req.headers['x-requested-with'] !== 'melodia') throw bad(403, 'Requisição não autorizada');
  const o = req.headers.origin;
  if (o && m !== 'GET') { let h = ''; try { h = new URL(o).host; } catch (e) { } if (h !== req.headers.host) throw bad(403, 'Origem inválida'); }
  const parts = p.split('/').filter(Boolean).slice(1), a = parts[0], ip = req.socket.remoteAddress;
  const body = (m === 'POST' || m === 'PUT' || m === 'PATCH') ? await readBody(req) : {};

  if (a === 'status' && m === 'GET') return send(res, 200, { needsSetup: Q('SELECT COUNT(*) c FROM users').get().c === 0, allowSignup: CFG.signup });

  if (a === 'register' && m === 'POST') {
    const n = Q('SELECT COUNT(*) c FROM users').get().c;
    if (n > 0 && !CFG.signup) throw bad(403, 'Cadastro aberto desativado. Peça a um administrador.');
    limit('reg|' + ip);
    const user = await createUser(body, n === 0 ? 'admin' : 'user');
    audit(user.id, n === 0 ? 'setup.admin' : 'user.register', user.email);
    return send(res, 201, { user }, { 'Set-Cookie': startSession(res, user.id, ip) });
  }
  if (a === 'login' && m === 'POST') {
    const email = String(body.email || '').trim().toLowerCase(); limit(ip + '|' + email);
    const row = Q('SELECT * FROM users WHERE email=?').get(email);
    const ok = await checkPw(String(body.password || ''), row ? row.pass_hash : DUMMY);
    if (!row || !row.active || !ok) { audit(row && row.id, 'login.fail', email); throw bad(401, 'E-mail ou senha incorretos'); }
    tries.delete(ip + '|' + email);
    Q("UPDATE users SET last_login=datetime('now') WHERE id=?").run(row.id);
    audit(row.id, 'login', email);
    return send(res, 200, { user: pub(row) }, { 'Set-Cookie': startSession(res, row.id, ip) });
  }

  const user = auth(req);
  if (!user) throw bad(401, 'Sessão expirada. Entre novamente.');

  if (a === 'logout' && m === 'POST') {
    Q('DELETE FROM sessions WHERE token_hash=?').run(user.th);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'mo_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (a === 'me' && parts.length === 1 && m === 'GET') return send(res, 200, { user: pub(user) });
  if (a === 'me' && parts[1] === 'password' && m === 'POST') {
    const row = Q('SELECT pass_hash FROM users WHERE id=?').get(user.id);
    if (!(await checkPw(String(body.current || ''), row.pass_hash))) throw bad(403, 'Senha atual incorreta');
    Q('UPDATE users SET pass_hash=? WHERE id=?').run(await hashPw(cleanPw(body.next)), user.id);
    Q('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(user.id, user.th);
    audit(user.id, 'password.change');
    return send(res, 200, { ok: true });
  }

  if (a === 'projects') {
    const id = parts[1];
    if (!id && m === 'GET') {
      const full = u.searchParams.get('full') === '1';
      const rows = Q('SELECT id,name,version,created_at,updated_at' + (full ? ',data' : '') + ' FROM projects WHERE owner_id=? ORDER BY updated_at DESC').all(user.id);
      return send(res, 200, { projects: rows.map(r => full ? { ...r, data: JSON.parse(r.data) } : r) });
    }
    if (!id || !PID.test(id)) throw bad(400, 'Identificador de projeto inválido');
    const cur = Q('SELECT * FROM projects WHERE id=?').get(id);
    if (m === 'GET') {
      if (!cur || (cur.owner_id !== user.id && user.role !== 'admin')) throw bad(404, 'Projeto não encontrado');
      return send(res, 200, { project: { id: cur.id, name: cur.name, version: cur.version, updated_at: cur.updated_at, data: JSON.parse(cur.data) } });
    }
    if (m === 'PUT') {
      const name = String(body.name ?? '').trim().slice(0, 120) || 'Sem nome';
      if (!body.data || typeof body.data !== 'object' || !Array.isArray(body.data.tracks)) throw bad(400, 'Dados do projeto inválidos');
      if (cur && cur.owner_id !== user.id) throw bad(403, 'Este projeto pertence a outro usuário');
      const json = JSON.stringify(body.data);
      if (cur) Q("UPDATE projects SET name=?,data=?,version=version+1,updated_at=datetime('now') WHERE id=?").run(name, json, id);
      else { Q('INSERT INTO projects(id,owner_id,name,data) VALUES(?,?,?,?)').run(id, user.id, name, json); audit(user.id, 'project.create', name); }
      const r = Q('SELECT version,updated_at FROM projects WHERE id=?').get(id);
      return send(res, 200, r);
    }
    if (m === 'DELETE') {
      if (!cur || (cur.owner_id !== user.id && user.role !== 'admin')) throw bad(404, 'Projeto não encontrado');
      Q('DELETE FROM projects WHERE id=?').run(id); audit(user.id, 'project.delete', cur.name);
      return send(res, 200, { ok: true });
    }
  }

  if (a === 'admin') {
    if (user.role !== 'admin') throw bad(403, 'Apenas administradores');
    const what = parts[1], id = parts[2] ? +parts[2] : null;
    if (what === 'users' && !id && m === 'GET')
      return send(res, 200, { users: Q('SELECT u.id,u.name,u.email,u.role,u.active,u.created_at,u.last_login,(SELECT COUNT(*) FROM projects WHERE owner_id=u.id) projects FROM users u ORDER BY u.id').all() });
    if (what === 'users' && !id && m === 'POST') {
      const nu = await createUser(body, body.role === 'admin' ? 'admin' : 'user'); audit(user.id, 'user.create', nu.email);
      return send(res, 201, { user: nu });
    }
    if (what === 'users' && id && (m === 'PATCH' || m === 'DELETE')) {
      const t = Q('SELECT * FROM users WHERE id=?').get(id); if (!t) throw bad(404, 'Usuário não encontrado');
      const otherAdmins = () => Q("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1 AND id<>?").get(t.id).c;
      if (m === 'DELETE') {
        if (t.id === user.id) throw bad(409, 'Você não pode excluir a própria conta');
        if (t.role === 'admin' && t.active && !otherAdmins()) throw bad(409, 'É preciso manter ao menos um administrador ativo');
        Q('DELETE FROM users WHERE id=?').run(t.id); audit(user.id, 'user.delete', t.email);
        return send(res, 200, { ok: true });
      }
      const nx = { name: t.name, role: t.role, active: t.active };
      if (body.name !== undefined) nx.name = cleanName(body.name);
      if (body.role !== undefined) { if (!['admin', 'user'].includes(body.role)) throw bad(400, 'Perfil inválido'); nx.role = body.role; }
      if (body.active !== undefined) nx.active = body.active ? 1 : 0;
      if (t.role === 'admin' && t.active && (nx.role !== 'admin' || !nx.active) && !otherAdmins()) throw bad(409, 'É preciso manter ao menos um administrador ativo');
      Q('UPDATE users SET name=?,role=?,active=? WHERE id=?').run(nx.name, nx.role, nx.active, t.id);
      if (body.password !== undefined) { Q('UPDATE users SET pass_hash=? WHERE id=?').run(await hashPw(cleanPw(body.password)), t.id); Q('DELETE FROM sessions WHERE user_id=?').run(t.id); }
      if (!nx.active) Q('DELETE FROM sessions WHERE user_id=?').run(t.id);
      audit(user.id, 'user.update', t.email);
      return send(res, 200, { ok: true });
    }
    if (what === 'projects' && m === 'GET')
      return send(res, 200, { projects: Q('SELECT p.id,p.name,p.version,p.updated_at,u.name owner,u.email FROM projects p JOIN users u ON u.id=p.owner_id ORDER BY p.updated_at DESC LIMIT 500').all() });
    if (what === 'audit' && m === 'GET')
      return send(res, 200, { events: Q('SELECT a.at,a.action,a.detail,u.email FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100').all() });
  }
  throw bad(404, 'Rota não encontrada');
}

/* ---------- arquivos estáticos ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw bad(405, 'Método não permitido');
  let rel; try { rel = decodeURIComponent(p); } catch (e) { throw bad(400, 'Caminho inválido'); }
  const f = path.normalize(path.join(PUB, rel === '/' ? 'index.html' : rel));
  if (!f.startsWith(PUB + path.sep)) throw bad(403, 'Acesso negado');
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (u.pathname.startsWith('/api/')) return await api(req, res, u, u.pathname);
    return serveStatic(req, res, u.pathname);
  } catch (e) {
    if (e.http) return send(res, e.http, { error: e.message });
    console.error(e); send(res, 500, { error: 'Erro interno do servidor' });
  }
});
server.listen(CFG.port, CFG.host, () => console.log(`MelodIA Orquestra ouvindo em http://${CFG.host}:${CFG.port}  (dados em ${CFG.data})`));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { server.close(); try { db.close(); } catch (e) { } process.exit(0); });
