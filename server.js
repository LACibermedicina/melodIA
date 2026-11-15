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
  maxBody: (+env.MAX_BODY_MB || 10) * 1048576,
  tr: {
    key: env.TRANSCRIBE_API_KEY || env.OPENAI_API_KEY || '',
    url: env.TRANSCRIBE_URL || 'https://api.openai.com/v1/audio/transcriptions',
    model: env.TRANSCRIBE_MODEL || 'whisper-1',
    max: (+env.TRANSCRIBE_MAX_MB || 25) * 1048576
  },
  ai: {
    provider: env.AI_PROVIDER || (env.AI_API_KEY || env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY ? 'openai' : ''),
    key: env.AI_API_KEY || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || '',
    url: env.AI_URL || '',
    model: env.AI_MODEL || ''
  }
};
/* IA com failsafe: cada provedor configurado entra na fila (ordem em AI_ORDER); se um falha, o próximo responde */
function aiChain() {
  const L = [], seen = new Set(), add = (provider, key, url, model) => { key = String(key || '').trim(); if (!key || seen.has(provider + key)) return; seen.add(provider + key); L.push({ provider, key, url: url || '', model: model || '' }); };
  const order = String(env.AI_ORDER || 'anthropic,gemini,openai,pollinations').split(',').map(x => x.trim()).filter(Boolean);
  if (CFG.ai.provider && CFG.ai.key) add(CFG.ai.provider, CFG.ai.key, CFG.ai.url, CFG.ai.model);
  for (const p of order) {
    if (p === 'anthropic') add('anthropic', env.ANTHROPIC_API_KEY, '', env.ANTHROPIC_MODEL);
    if (p === 'openai') add('openai', env.OPENAI_API_KEY, env.OPENAI_URL, env.OPENAI_MODEL);
    if (p === 'gemini') for (const k of [env.GEMINI_API_KEY, env.GOOGLE_API_KEY, env.GEMINI_CURL_API_KEY]) add('gemini', k, '', env.GEMINI_MODEL);
    if (p === 'pollinations') add('openai', env.POLLINATIONS_API_KEY, 'https://gen.pollinations.ai/v1/chat/completions', env.POLLINATIONS_MODEL || 'openai');
  }
  return L;
}
const AI_LIST = aiChain(), AI_BAD = new Map();
async function aiOne(A, system, prompt, max) {
  let url, headers, payload;
  if (A.provider === 'anthropic') {
    url = A.url || 'https://api.anthropic.com/v1/messages';
    headers = { 'x-api-key': A.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    payload = { model: A.model || 'claude-haiku-5-5', max_tokens: max, system: system || undefined, messages: [{ role: 'user', content: prompt }] };
  } else if (A.provider === 'gemini') {
    url = A.url || 'https://generativelanguage.googleapis.com/v1beta/models/' + (A.model || 'gemini-flash-latest') + ':generateContent';
    headers = { 'x-goog-api-key': A.key, 'content-type': 'application/json' };
    payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: max, thinkingConfig: { thinkingBudget: 0 } } };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };
  } else {
    url = A.url || 'https://api.openai.com/v1/chat/completions';
    headers = { Authorization: 'Bearer ' + A.key, 'content-type': 'application/json' };
    payload = { model: A.model || 'gpt-4o-mini', max_tokens: max, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }] };
  }
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(90000) });
  let j = null; try { j = await r.json(); } catch (e) { }
  if (!r.ok) throw new Error(A.provider + ' ' + r.status);
  const text = A.provider === 'anthropic' ? ((j && j.content || []).map(c => c.text || '').join(''))
    : A.provider === 'gemini' ? ((j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map(p => p.text || '').join('')
    : (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  if (!String(text).trim()) throw new Error(A.provider + ' sem texto');
  return String(text).trim();
}
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
function readRaw(req, max) {
  return new Promise((ok, ko) => {
    let n = 0, dead = false; const c = [];
    req.on('data', d => { if (dead) return; n += d.length; if (n > max) { dead = true; ko(bad(413, 'Áudio grande demais para transcrever')); return; } c.push(d); });
    req.on('end', () => { if (!dead) ok(Buffer.concat(c)); });
    req.on('error', ko);
  });
}
async function transcribe(req, res, user) {
  if (!CFG.tr.key) throw bad(501, 'A transcrição no servidor não está configurada');
  limit('tr|' + user.id, 30);
  const wav = await readRaw(req, CFG.tr.max);
  if (wav.length < 1000 || wav.toString('latin1', 0, 4) !== 'RIFF') throw bad(400, 'Envie um arquivo WAV válido');
  const bd = '----melodia' + crypto.randomBytes(12).toString('hex'), parts = [];
  const field = (n, v) => parts.push(Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`));
  field('model', CFG.tr.model); field('language', 'pt'); field('response_format', 'json');
  parts.push(Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`), wav, Buffer.from(`\r\n--${bd}--\r\n`));
  let r, j = null;
  try {
    r = await fetch(CFG.tr.url, { method: 'POST', headers: { Authorization: 'Bearer ' + CFG.tr.key, 'Content-Type': 'multipart/form-data; boundary=' + bd }, body: Buffer.concat(parts), signal: AbortSignal.timeout(180000) });
    try { j = await r.json(); } catch (e) { }
  } catch (e) { console.error('transcrição:', e.message); throw bad(502, 'Não foi possível falar com o provedor de transcrição'); }
  if (!r.ok) { console.error('transcrição: provedor respondeu', r.status); throw bad(502, 'O provedor recusou a transcrição (' + r.status + ')'); }
  audit(user.id, 'transcribe', Math.round(wav.length / 1024) + ' KB');
  return send(res, 200, { text: String((j && j.text) || '').trim() });
}

async function askAI(req, res, user, body) {
  if (!AI_LIST.length) throw bad(501, 'A IA no servidor não está configurada');
  limit('ai|' + user.id, 60);
  const prompt = String(body.prompt || '').slice(0, 12000); if (!prompt) throw bad(400, 'Escreva o pedido para a IA');
  const system = String(body.system || '').slice(0, 4000), max = Math.min(+body.max_tokens || 1500, 4000);
  /* provedores que falharam há menos de 5 min vão para o fim da fila */
  const now = Date.now(), fila = AI_LIST.filter(A => !(AI_BAD.get(A) > now)).concat(AI_LIST.filter(A => AI_BAD.get(A) > now)), erros = [];
  for (const A of fila) {
    try { const text = await aiOne(A, system, prompt, max); AI_BAD.delete(A); return send(res, 200, { text, provider: A.provider }); }
    catch (e) { erros.push(e.message); AI_BAD.set(A, now + 5 * 60000); console.error('ia: falhou', e.message); }
  }
  throw bad(502, 'Nenhum provedor de IA respondeu (' + erros.join('; ') + ')');
}
const rad = d => d * Math.PI / 180;
function km(a, b, c, d) { const x = rad(c - a), y = rad(d - b), h = Math.sin(x / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(y / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); }
const KEY = /^[a-z0-9_.-]{1,40}$/;

function cookie(req, name) {
  for (const p of (req.headers.cookie || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i).trim() === name) { try { return decodeURIComponent(p.slice(i + 1).trim()); } catch (e) { return ''; } }
  }
  return '';
}
const audit = (uid, action, detail) => Q('INSERT INTO audit(user_id,action,detail) VALUES(?,?,?)').run(uid ?? null, action, detail ? String(detail).slice(0, 300) : null);

/* IP real do visitante: atrás do proxy reverso (TRUST_PROXY=true) vem do cabeçalho X-Real-IP que o nginx grava */
function clientIp(req) {
  if (env.TRUST_PROXY === 'true') { const h = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (h) return h; }
  return req.socket.remoteAddress;
}
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
  const r = Q('SELECT u.id,u.name,u.email,u.role,u.active,s.token_hash th,s.expires_at ex,u.last_login FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(sha(t));
  return r && r.active && r.ex > Date.now() ? r : null;
}
const tries = new Map();
function limit(key, max = 8) {
  const now = Date.now(), a = (tries.get(key) || []).filter(t => now - t < 15 * 60e3);
  if (a.length >= max) throw bad(429, 'Muitas tentativas. Aguarde alguns minutos.');
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

/* ---------- canto natural: fila para o serviço Python local (voz neural + WORLD) ---------- */
const CANTO = { port: +env.CANTO_PORT || 0, dir: path.join(CFG.data, 'canto'), ver: 'c1' };
for (const d of ['refs', 'out', 'tr']) fs.mkdirSync(path.join(CANTO.dir, d), { recursive: true });
const CJOBS = new Map(); let cantoChain = Promise.resolve();
function cantoCall(method, p, body, ms) {
  return new Promise((ok, ko) => {
    if (!CANTO.port) return ko(bad(503, 'Canto natural não instalado neste servidor'));
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const rq = http.request({ host: '127.0.0.1', port: CANTO.port, path: p, method, timeout: ms || 5000, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, r => {
      const c = []; r.on('data', d => c.push(d)); r.on('end', () => { let j = {}; try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch (e) { } r.statusCode < 300 ? ok(j) : ko(bad(502, j.error || 'Falha no serviço de canto')); });
    });
    rq.on('timeout', () => rq.destroy(bad(504, 'O serviço de canto demorou demais')));
    rq.on('error', e => ko(e.http ? e : bad(503, 'Serviço de canto indisponível')));
    if (data) rq.write(data); rq.end();
  });
}
const refPath = (uid, vid) => path.join(CANTO.dir, 'refs', String(uid), vid + '.wav');
function cleanNotes(a) {
  if (!Array.isArray(a) || a.length > 4000) throw bad(400, 'Notas inválidas');
  return a.map(n => ({ t: +n.t || 0, d: Math.max(0.01, Math.min(64, +n.d || 0)), m: Math.max(20, Math.min(100, Math.round(+n.m || 60))), s: String(n.s || '').slice(0, 12), wi: !!n.wi, wf: !!n.wf }));
}
function cantoPrune() {
  try {
    const dir = path.join(CANTO.dir, 'out'), fl = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const x of fl.slice(1500)) { const b = x.f.slice(0, -5); for (const s of ['.json', '_lead.wav', '_harm.wav']) fs.rmSync(path.join(dir, b + s), { force: true }); }
  } catch (e) { }
}
async function cantoApi(req, res, user, parts, m, body) {
  const out = path.join(CANTO.dir, 'out');
  if (parts[1] === 'status' && m === 'GET') {
    try { const st = await cantoCall('GET', '/status', null, 3000); return send(res, 200, Object.assign({ available: true }, st)); }
    catch (e) { return send(res, 200, { available: false, reason: e.message }); }
  }
  if (!user) throw bad(401, 'Sessão expirada. Entre novamente.');
  if (parts[1] === 'ref' && PID.test(parts[2] || '')) {
    const f = refPath(user.id, parts[2]);
    if (m === 'DELETE') { fs.rmSync(f, { force: true }); return send(res, 200, { ok: true }); }
    if (m === 'GET') return send(res, 200, { exists: fs.existsSync(f) });
  }
  if (parts[1] === 'jobs' && m === 'POST') {
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 2) throw bad(400, 'Linhas vocais inválidas');
    const lines = body.lines.map(l => ({ id: l.id === 'harm' ? 'harm' : 'lead', notes: cleanNotes(l.notes), alpha: Math.max(.8, Math.min(1.25, +l.alpha || 1)) }));
    if (!lines[0].notes.length) throw bad(400, 'Gere a voz na melodia antes do canto natural');
    const vid = PID.test(String(body.ref || '')) ? String(body.ref) : '', rf = vid ? refPath(user.id, vid) : '';
    const hasRef = !!(rf && fs.existsSync(rf));
    const job = { lines, bpm: Math.max(30, Math.min(260, +body.bpm || 100)), vd: body.vd && typeof body.vd === 'object' ? body.vd : {}, voice: body.voice && typeof body.voice === 'object' ? body.voice : {},
      seed: (+body.seed || 1) >>> 0, ar: Math.max(.5, Math.min(1, +body.ar || .9)), gpu: !!body.gpu && hasRef };
    const sig = sha(JSON.stringify([CANTO.ver, job, hasRef ? fs.statSync(rf).mtimeMs : 0])).slice(0, 40);
    const done = path.join(out, sig + '.json');
    if (fs.existsSync(done)) return send(res, 200, { id: sig, status: 'done', result: JSON.parse(fs.readFileSync(done, 'utf8')) });
    if (!CJOBS.has(sig)) {
      const mine = [...CJOBS.values()].filter(j => j.uid === user.id && j.status !== 'done' && j.status !== 'error').length;
      if (mine >= 2) throw bad(429, 'Você já tem cantos na fila. Aguarde terminarem.');
      const rec = { uid: user.id, status: 'queued', created: Date.now() }; CJOBS.set(sig, rec);
      cantoChain = cantoChain.then(async () => {
        rec.status = 'running';
        try {
          const r = await cantoCall('POST', '/render', Object.assign({}, job, { ref: hasRef ? rf : null, outdir: out, base: sig, progress: path.join(out, sig + '.progress') }), 15 * 60000);
          r.urls = {}; for (const k of Object.keys(r.files || {})) r.urls[k] = '/api/canto/audio/' + r.files[k];
          fs.writeFileSync(done, JSON.stringify(r)); rec.status = 'done'; rec.result = r; audit(user.id, 'canto', sig + ' ' + r.ms + 'ms'); cantoPrune();
        } catch (e) { rec.status = 'error'; rec.error = e.message; }
        fs.rmSync(path.join(out, sig + '.progress'), { force: true });
        setTimeout(() => CJOBS.delete(sig), 30 * 60000);
      });
    }
    const rec = CJOBS.get(sig); return send(res, 200, { id: sig, status: rec.status, result: rec.result, error: rec.error });
  }
  if (parts[1] === 'jobs' && /^[a-f0-9]{40}$/.test(parts[2] || '') && m === 'GET') {
    const sig = parts[2], rec = CJOBS.get(sig), done = path.join(out, sig + '.json');
    if (!rec && fs.existsSync(done)) return send(res, 200, { id: sig, status: 'done', result: JSON.parse(fs.readFileSync(done, 'utf8')) });
    const dtr = path.join(CANTO.dir, 'tr', sig + '.json');
    if (!rec && fs.existsSync(dtr)) return send(res, 200, { id: sig, status: 'done', result: JSON.parse(fs.readFileSync(dtr, 'utf8')) });
    if (!rec) throw bad(404, 'Trabalho de canto não encontrado');
    let pr = null; try { pr = JSON.parse(fs.readFileSync(path.join(out, sig + '.progress'), 'utf8')); } catch (e) { }
    const ahead = rec.status === 'queued' ? [...CJOBS.values()].filter(j => j.status === 'running' || (j.status === 'queued' && j.created < rec.created)).length : 0;
    return send(res, 200, { id: sig, status: rec.status, progress: pr, ahead, result: rec.result, error: rec.error });
  }
  throw bad(404, 'Rota de canto não encontrada');
}
function cantoAudio(req, res, file) {
  if (!/^[a-f0-9]{40}_(lead|harm)\.wav$/.test(file)) throw bad(404, 'Áudio não encontrado');
  const f = path.join(CANTO.dir, 'out', file);
  fs.stat(f, (err, st) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=31536000, immutable' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(f).pipe(res);
  });
}

/* ---------- API ---------- */
async function api(req, res, u, p) {
  const m = req.method;
  if (m !== 'GET' && req.headers['x-requested-with'] !== 'melodia') throw bad(403, 'Requisição não autorizada');
  const o = req.headers.origin;
  if (o && m !== 'GET') { let h = ''; try { h = new URL(o).host; } catch (e) { } if (h !== req.headers.host) throw bad(403, 'Origem inválida'); }
  const parts = p.split('/').filter(Boolean).slice(1), a = parts[0], ip = clientIp(req);
  if (a === 'transcribe' && m === 'POST') { const tu = auth(req); if (!tu) throw bad(401, 'Sessão expirada. Entre novamente.'); return await transcribe(req, res, tu); }
  if (a === 'canto' && parts[1] === 'audio' && (m === 'GET' || m === 'HEAD')) return cantoAudio(req, res, parts[2] || '');
  if (a === 'canto' && parts[1] === 'transcrever' && m === 'POST') {
    const cu = auth(req); if (!cu) throw bad(401, 'Sessão expirada. Entre novamente.');
    if (!CANTO.port) throw bad(503, 'Transcrição de canto não instalada neste servidor');
    limit('trc:' + cu.id, 20);
    const b = await readRaw(req, 40 * 1048576);
    if (b.length < 4000 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw bad(400, 'Envie o trecho em WAV');
    const asr = String((parts[2] || '')) !== 'sem-letra';
    const sig = sha(Buffer.concat([Buffer.from(CANTO.ver + 'tr2' + (asr ? 'a' : 'n')), b])).slice(0, 40), dir = path.join(CANTO.dir, 'tr'), done = path.join(dir, sig + '.json');
    if (fs.existsSync(done)) return send(res, 200, { id: sig, status: 'done', result: JSON.parse(fs.readFileSync(done, 'utf8')) });
    if (!CJOBS.has(sig)) {
      const wav = path.join(dir, sig + '.wav'); fs.writeFileSync(wav, b);
      const rec = { uid: cu.id, status: 'queued', created: Date.now(), kind: 'tr' }; CJOBS.set(sig, rec);
      cantoChain = cantoChain.then(async () => {
        rec.status = 'running';
        try {
          const r = await cantoCall('POST', '/transcrever', { wav, asr, progress: path.join(CANTO.dir, 'out', sig + '.progress') }, 20 * 60000);
          fs.writeFileSync(done, JSON.stringify(r)); rec.status = 'done'; rec.result = r; audit(cu.id, 'transcrever', sig + ' ' + r.ms + 'ms ' + (r.words || []).length + ' palavras');
        } catch (e) { rec.status = 'error'; rec.error = e.message; }
        fs.rmSync(wav, { force: true }); fs.rmSync(path.join(CANTO.dir, 'out', sig + '.progress'), { force: true });
        setTimeout(() => CJOBS.delete(sig), 30 * 60000);
      });
    }
    const rec = CJOBS.get(sig); return send(res, 200, { id: sig, status: rec.status, result: rec.result, error: rec.error });
  }
  if (a === 'canto' && parts[1] === 'ref' && m === 'POST') {
    const cu = auth(req); if (!cu) throw bad(401, 'Sessão expirada. Entre novamente.');
    if (!PID.test(parts[2] || '')) throw bad(400, 'Voz inválida');
    limit('ref:' + cu.id, 30);
    const b = await readRaw(req, 6 * 1048576);
    if (b.length < 2000 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw bad(400, 'Envie a amostra da voz em WAV');
    const f = refPath(cu.id, parts[2]); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, b);
    return send(res, 200, { ok: true, bytes: b.length });
  }
  const body = (m === 'POST' || m === 'PUT' || m === 'PATCH') ? await readBody(req) : {};
  if (a === 'ai' && m === 'POST') { const au = auth(req); if (!au) throw bad(401, 'Sessão expirada. Entre novamente.'); return await askAI(req, res, au, body); }

  if (a === 'status' && m === 'GET') return send(res, 200, { needsSetup: Q('SELECT COUNT(*) c FROM users').get().c === 0, allowSignup: CFG.signup, transcribe: !!CFG.tr.key, ai: AI_LIST.length > 0, aiProviders: AI_LIST.map(A => A.url.includes('pollinations') ? 'pollinations' : A.provider), canto: !!CANTO.port });
  if (a === 'canto') return await cantoApi(req, res, auth(req), parts, m, body);

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
  if (a === 'me' && parts.length === 1 && m === 'GET') return send(res, 200, { user: { ...pub(user), last_login: user.last_login } });
  if (a === 'me' && parts[1] === 'logout-all' && m === 'POST') {
    Q('DELETE FROM sessions WHERE user_id=?').run(user.id); audit(user.id, 'logout.all');
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'mo_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (a === 'me' && parts[1] === 'password' && m === 'POST') {
    const row = Q('SELECT pass_hash FROM users WHERE id=?').get(user.id);
    if (!(await checkPw(String(body.current || ''), row.pass_hash))) throw bad(403, 'Senha atual incorreta');
    Q('UPDATE users SET pass_hash=? WHERE id=?').run(await hashPw(cleanPw(body.next)), user.id);
    Q('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(user.id, user.th);
    audit(user.id, 'password.change');
    return send(res, 200, { ok: true });
  }

  if (a === 'userdata') {
    const k = parts[1]; if (!k || !KEY.test(k)) throw bad(400, 'Chave inválida');
    if (m === 'GET') { const r = Q('SELECT v FROM userdata WHERE user_id=? AND k=?').get(user.id, k); return send(res, 200, { value: r ? JSON.parse(r.v) : null }); }
    if (m === 'PUT') { if (body.value === undefined) throw bad(400, 'Envie "value"'); Q("INSERT INTO userdata(user_id,k,v) VALUES(?,?,?) ON CONFLICT(user_id,k) DO UPDATE SET v=excluded.v,updated_at=datetime('now')").run(user.id, k, JSON.stringify(body.value)); return send(res, 200, { ok: true }); }
    if (m === 'DELETE') { Q('DELETE FROM userdata WHERE user_id=? AND k=?').run(user.id, k); return send(res, 200, { ok: true }); }
  }

  if (a === 'radia') {
    const id = parts[1];
    if (!id && m === 'GET') {
      const lat = +u.searchParams.get('lat'), lon = +u.searchParams.get('lon'), lim = Math.min(+u.searchParams.get('limit') || 30, 100);
      if (!isFinite(lat) || !isFinite(lon)) throw bad(400, 'Informe lat e lon');
      const all = Q('SELECT p.id,p.lat,p.lon FROM posts p ORDER BY p.created_at DESC LIMIT 5000').all()
        .map(r => ({ id: r.id, d: km(lat, lon, r.lat, r.lon) })).sort((x, y) => x.d - y.d).slice(0, lim);
      const out = all.map(x => { const r = Q('SELECT p.id,p.title,p.descr,p.lat,p.lon,p.created_at,u.name author,p.owner_id,json_extract(p.data,\'$.cover\') cover FROM posts p JOIN users u ON u.id=p.owner_id WHERE p.id=?').get(x.id); return { ...r, dist_km: Math.round(x.d), mine: r.owner_id === user.id, owner_id: undefined }; });
      return send(res, 200, { posts: out });
    }
    if (!id && m === 'POST') {
      limit('post|' + user.id, 20);
      const title = String(body.title || '').trim().slice(0, 100), lat = +body.lat, lon = +body.lon;
      if (!title) throw bad(400, 'Dê um título à publicação');
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw bad(400, 'Posição inválida');
      if (!body.data || !Array.isArray(body.data.tracks)) throw bad(400, 'Composição inválida');
      const json = JSON.stringify(body.data); if (json.length > 3 * 1048576) throw bad(413, 'Composição grande demais para publicar');
      const pid = crypto.randomBytes(9).toString('base64url');
      Q('INSERT INTO posts(id,owner_id,title,descr,lat,lon,data) VALUES(?,?,?,?,?,?,?)').run(pid, user.id, title, String(body.desc || '').slice(0, 600), lat, lon, json);
      audit(user.id, 'radia.publish', title); return send(res, 201, { id: pid });
    }
    if (id && !/^[A-Za-z0-9_-]{6,40}$/.test(id)) throw bad(400, 'Identificador inválido');
    const post = id ? Q('SELECT p.*,u.name author FROM posts p JOIN users u ON u.id=p.owner_id WHERE p.id=?').get(id) : null;
    if (id && m === 'GET') { if (!post) throw bad(404, 'Publicação não encontrada'); return send(res, 200, { post: { id: post.id, title: post.title, descr: post.descr, lat: post.lat, lon: post.lon, author: post.author, created_at: post.created_at, data: JSON.parse(post.data) } }); }
    if (id && m === 'DELETE') { if (!post || (post.owner_id !== user.id && user.role !== 'admin')) throw bad(404, 'Publicação não encontrada'); Q('DELETE FROM posts WHERE id=?').run(id); audit(user.id, 'radia.delete', post.title); return send(res, 200, { ok: true }); }
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
