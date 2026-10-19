const test = require('node:test');
const assert = require('node:assert');
const { open } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');
const ml = require('../src/ml');
const { today, monthOf } = require('../src/util');

let server, base, db;

test.before(async () => {
  db = open(':memory:');
  await seed(db, { students: 120, weeks: 6 });
  ml.trainModel(db);
  server = createApp(db).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());

async function login(username, password) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.strictEqual(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(base + '/api' + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : await r.text() };
  };
}

test('rejects wrong passwords and anonymous requests', async () => {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'nope' }) });
  assert.strictEqual(res.status, 401);
  assert.strictEqual((await fetch(base + '/api/students')).status, 401);
});

test('roles only see what they should', async () => {
  const student = await login('student', 'student123');
  assert.strictEqual((await student('/students')).status, 403);
  assert.strictEqual((await student('/teachers')).status, 403);
  assert.strictEqual((await student('/students/2')).status, 403);
  assert.strictEqual((await student('/students/1')).status, 200);
  const teacher = await login('teacher', 'teacher123');
  assert.strictEqual((await teacher('/payments')).status, 403);
  const mine = await teacher('/students');
  assert.ok(mine.body.students.length > 0);
  const total = db.prepare('SELECT COUNT(*) AS n FROM students').get().n;
  assert.ok(mine.body.students.length < total);
});

test('admin can register, edit and delete a student', async () => {
  const admin = await login('admin', 'admin123');
  const cls = db.prepare("SELECT id FROM classes WHERE grade = 10 AND branch_id = 1 AND subject = 'ICT'").get();
  const created = await admin('/students', { method: 'POST', body: { name: 'Test Student', grade: 10, branch_id: 1, classIds: [cls.id], password: 'secret12' } });
  assert.strictEqual(created.status, 201);
  const id = created.body.student.id;
  const code = created.body.student.code;
  const bad = await admin('/students', { method: 'POST', body: { name: '', grade: 10, branch_id: 1 } });
  assert.strictEqual(bad.status, 400);
  const wrongGrade = await admin(`/students/${id}`, { method: 'PUT', body: { name: 'Test Student', grade: 11, branch_id: 1, classIds: [cls.id] } });
  assert.strictEqual(wrongGrade.status, 400);
  await login(code.toLowerCase(), 'secret12'); // the portal login works
  assert.strictEqual((await admin(`/students/${id}`, { method: 'DELETE' })).status, 200);
  assert.strictEqual((await admin(`/students/${id}`)).status, 404);
});

test('generate, publish and move timetable sessions', async () => {
  const coord = await login('coordinator', 'coord123');
  const gen = await coord('/schedule/generate', { method: 'POST', body: { branchId: 2, grades: [6, 7, 8, 9, 10, 11, 12, 13], priority: 'workload' } });
  assert.strictEqual(gen.status, 200);
  assert.strictEqual(gen.body.conflicts.length, 0);
  assert.strictEqual(gen.body.unplaced.length, 0);
  const pub = await coord('/schedule/publish', { method: 'POST', body: { previewId: gen.body.previewId } });
  assert.strictEqual(pub.status, 200);
  assert.strictEqual((await coord('/schedule/publish', { method: 'POST', body: { previewId: gen.body.previewId } })).status, 400);
  const { sessions } = (await coord('/schedule?branch=2')).body;
  const [a, b] = sessions;
  const clash = await coord(`/schedule/sessions/${a.id}`, { method: 'PUT', body: { day: b.day, hour: b.hour, roomId: b.room_id } });
  assert.strictEqual(clash.status, 409);
  assert.ok(clash.body.issues.includes('room_busy'));
  const stay = await coord(`/schedule/sessions/${a.id}/check`, { method: 'POST', body: { day: a.day, hour: a.hour, roomId: a.room_id } });
  assert.strictEqual(stay.body.ok, true);
});

test('teacher marks attendance and parents of absent students get a message', async () => {
  const teacher = await login('teacher', 'teacher123');
  const cls = db.prepare('SELECT id FROM classes WHERE teacher_id = 1 LIMIT 1').get();
  const roster = await teacher(`/attendance/class/${cls.id}?date=${today()}`);
  assert.strictEqual(roster.status, 200);
  const records = roster.body.students.map((s, i) => ({ studentId: s.id, status: i === 0 ? 'absent' : 'present' }));
  const before = db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n;
  const saved = await teacher('/attendance', { method: 'POST', body: { classId: cls.id, date: today(), records } });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.body.counts.absent, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, before + 1);
  const other = db.prepare('SELECT id FROM classes WHERE teacher_id != 1 LIMIT 1').get();
  assert.strictEqual((await teacher('/attendance', { method: 'POST', body: { classId: other.id, date: today(), records } })).status, 403);
  const future = await teacher('/attendance', { method: 'POST', body: { classId: cls.id, date: '2999-01-01', records } });
  assert.strictEqual(future.status, 400);
});

test('payments: record once per month, receipt, reminders', async () => {
  const admin = await login('admin', 'admin123');
  const m = monthOf(today());
  const dues = await admin('/payments/dues?month=' + m);
  const unpaid = dues.body.rows.find((r) => !r.payment_id);
  const pay = await admin('/payments', { method: 'POST', body: { studentId: unpaid.id, month: m, method: 'cash' } });
  assert.strictEqual(pay.status, 201);
  assert.strictEqual(pay.body.payment.amount, unpaid.fee);
  assert.strictEqual((await admin('/payments', { method: 'POST', body: { studentId: unpaid.id, month: m } })).status, 409);
  const receipt = await admin(`/payments/${pay.body.payment.id}/receipt`);
  assert.strictEqual(receipt.body.payment.receipt_no, pay.body.payment.receipt_no);
  const rem = await admin('/payments/reminders', { method: 'POST', body: { month: m } });
  assert.strictEqual(rem.body.reminded, dues.body.summary.unpaid - 1);
});

test('reports and dashboards load for each role', async () => {
  for (const [u, p] of [['admin', 'admin123'], ['coordinator', 'coord123'], ['teacher', 'teacher123'], ['student', 'student123']]) {
    const api = await login(u, p);
    const d = await api('/dashboard');
    assert.strictEqual(d.status, 200, u);
  }
  const admin = await login('admin', 'admin123');
  const r = await admin('/reports/overview');
  assert.ok(r.body.model.accuracy > 0.5);
  const csv = await admin('/reports/students.csv');
  assert.match(csv.body, /^"?Student ID"?,Name/);
});
