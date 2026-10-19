// Rebuild the demo database: node scripts/seed.js
const fs = require('fs');
const path = require('path');
const { open } = require('../src/db');
const { seed } = require('../src/seed');

const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'smarttutor.db');
for (const f of [file, file + '-wal', file + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
const db = open(file);
const started = Date.now();
seed(db).then(() => {
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  console.log(`Seeded ${file} in ${Date.now() - started} ms`);
  for (const t of ['students', 'teachers', 'classes', 'sessions', 'attendance', 'payments', 'marks', 'users']) console.log(`  ${t}: ${count(t)}`);
  db.close();
}).catch((err) => { console.error(err); process.exit(1); });
