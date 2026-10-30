'use strict';
// Cópia consistente do banco (pode rodar com o servidor ligado).
const path = require('node:path'), fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
const dst = path.join(dir, 'backups');
fs.mkdirSync(dst, { recursive: true });
const d = new Date(), p = n => String(n).padStart(2, '0');
const file = path.join(dst, `melodia-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`);
const db = new DatabaseSync(path.join(dir, 'melodia.db'));
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
db.close();
console.log('Backup criado:', file);
