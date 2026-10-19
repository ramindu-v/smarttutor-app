const test = require('node:test');
const assert = require('node:assert');
const scheduler = require('../src/scheduler');
const { slots } = require('../src/config');

function problem(overrides = {}) {
  const rooms = [{ id: 1, capacity: 20 }, { id: 2, capacity: 30 }, { id: 3, capacity: 40 }, { id: 4, capacity: 30, isLab: true }];
  const teachers = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, days: [0, 1, 2, 3, 4, 5, 6].filter((d) => (d + i) % 3 !== 0) }));
  const classes = [];
  let id = 1;
  for (let grade = 6; grade <= 13; grade++) {
    for (let k = 0; k < 4; k++) {
      classes.push({ id: id++, grade, teacherId: ((grade * 4 + k) % 8) + 1, size: 10 + ((grade * 7 + k * 5) % 28), needsLab: grade >= 12 && k === 1, preference: grade >= 12 ? 'weekend' : 'weekday' });
    }
  }
  return { slots: slots(), rooms, teachers, classes, settings: { maxPerDay: 3, noBackToBack: true, lunchBreak: true, priority: 'balanced' }, ...overrides };
}

function assertValid(p, result) {
  const cls = new Map(p.classes.map((c) => [c.id, c]));
  const room = new Map(p.rooms.map((r) => [r.id, r]));
  const teacher = new Map(p.teachers.map((t) => [t.id, t]));
  const seen = new Set();
  for (const a of result.assignments) {
    const c = cls.get(a.classId);
    for (const key of [`t${a.teacherId}`, `r${a.roomId}`, `g${a.grade}`]) {
      const k = `${key}@${a.day}-${a.hour}`;
      assert.ok(!seen.has(k), `double booking ${k}`);
      seen.add(k);
    }
    assert.ok(room.get(a.roomId).capacity >= c.size, 'room too small');
    if (c.needsLab) assert.ok(room.get(a.roomId).isLab, 'lab class outside a lab');
    assert.ok(teacher.get(a.teacherId).days.includes(a.day), 'teacher not available');
    if (p.settings.lunchBreak) assert.notStrictEqual(a.hour, 12, 'class during lunch');
  }
  const perDay = new Map();
  for (const a of result.assignments) {
    const k = `${a.teacherId}-${a.day}`;
    perDay.set(k, [...(perDay.get(k) || []), a.index]);
  }
  for (const idx of perDay.values()) {
    assert.ok(idx.length <= p.settings.maxPerDay, 'too many classes in a day');
    if (p.settings.noBackToBack) {
      idx.sort();
      for (let i = 1; i < idx.length; i++) assert.ok(idx[i] - idx[i - 1] > 1, 'back-to-back classes');
    }
  }
}

test('places every class without breaking any hard constraint', async () => {
  const p = problem();
  const r = await scheduler.generate(p);
  assert.strictEqual(r.unplaced.length, 0);
  assert.strictEqual(r.assignments.length, p.classes.length);
  assert.deepStrictEqual(r.conflicts, []);
  assertValid(p, r);
});

test('every optimisation priority gives a valid timetable', async () => {
  for (const priority of ['balanced', 'workload', 'rooms', 'preference']) {
    const p = problem();
    p.settings.priority = priority;
    const r = await scheduler.generate(p);
    assert.strictEqual(r.unplaced.length, 0, priority);
    assertValid(p, r);
  }
});

test('preference priority puts classes on their preferred kind of day', async () => {
  const p = problem();
  p.settings.priority = 'preference';
  const r = await scheduler.generate(p);
  const cls = new Map(p.classes.map((c) => [c.id, c]));
  const met = r.assignments.filter((a) => (cls.get(a.classId).preference === 'weekend') === (a.day >= 5)).length;
  assert.ok(met / r.assignments.length > 0.9);
});

test('explains why a class cannot be placed', async () => {
  const p = problem();
  p.classes.push({ id: 999, grade: 10, teacherId: 1, size: 80, needsLab: false, preference: 'any' });
  p.classes.push({ id: 998, grade: 10, teacherId: 77, size: 10, needsLab: false, preference: 'any' }); // unknown teacher: no availability
  const r = await scheduler.generate(p);
  const reasons = Object.fromEntries(r.unplaced.map((u) => [u.classId, u.reason]));
  assert.strictEqual(reasons[999], 'no_suitable_room');
  assert.strictEqual(reasons[998], 'teacher_unavailable');
  assertValid({ ...p, teachers: [...p.teachers, { id: 77, days: [] }] }, r);
});

test('keeps fixed sessions when rescheduling', async () => {
  const p = problem();
  const first = await scheduler.generate(p);
  const keep = first.assignments.slice(0, 20);
  const keptIds = new Set(keep.map((a) => a.classId));
  const r = await scheduler.generate({ ...p, classes: p.classes.filter((c) => !keptIds.has(c.id)), fixedClasses: p.classes.filter((c) => keptIds.has(c.id)), fixed: keep });
  for (const k of keep) {
    const again = r.assignments.find((a) => a.classId === k.classId);
    assert.deepStrictEqual([again.day, again.hour, again.roomId], [k.day, k.hour, k.roomId]);
  }
  assert.strictEqual(r.assignments.length, p.classes.length);
  assertValid(p, r);
});

test('checks manual moves against the rules', async () => {
  const p = problem();
  const r = await scheduler.generate(p);
  const [moving, other] = r.assignments;
  const others = r.assignments.filter((a) => a.classId !== moving.classId);
  const issues = await scheduler.checkMove(p, { classId: moving.classId, day: other.day, hour: other.hour, roomId: other.roomId }, others);
  assert.ok(issues.includes('room_busy'));
  const lunch = await scheduler.checkMove(p, { classId: moving.classId, day: 5, hour: 12, roomId: 3 }, others);
  assert.ok(lunch.includes('lunch_break'));
  const small = p.classes.find((c) => c.size > 20 && !c.needsLab);
  const tooSmall = await scheduler.checkMove(p, { classId: small.id, day: 5, hour: 8, roomId: 1 }, r.assignments.filter((a) => a.classId !== small.id));
  assert.ok(tooSmall.includes('room_too_small'));
  const same = await scheduler.checkMove(p, { classId: moving.classId, day: moving.day, hour: moving.hour, roomId: moving.roomId }, others);
  assert.deepStrictEqual(same, []);
});
