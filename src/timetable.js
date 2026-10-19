// Loads scheduling problems from the database, runs the Prolog solver and
// saves / reads timetables.
const scheduler = require('./scheduler');
const { slots, DAYS, DAY_HOURS } = require('./config');
const { nowStamp } = require('./util');

const DEFAULT_SETTINGS = { maxPerDay: 4, noBackToBack: true, lunchBreak: true, priority: 'balanced' };

const REASONS = {
  no_suitable_room: 'No room is big enough (or no lab is available) for this class',
  teacher_unavailable: 'The teacher has no available days',
  all_slots_conflict: "Every time the teacher is free clashes with another class, room or the grade's other classes",
  invalid_slot: 'That day and time is not a teaching slot',
  lunch_break: 'That slot is the lunch break',
  room_too_small: 'The room is too small for this class',
  needs_lab: 'This class needs a laboratory',
  teacher_busy: 'The teacher already has a class at that time',
  room_busy: 'The room is already booked at that time',
  grade_busy: 'Students of this grade already have a class at that time',
  max_per_day: 'The teacher would exceed the daily class limit',
  back_to_back: 'The teacher would have back-to-back classes',
};

function loadProblem(db, branchId, { grades, settings } = {}) {
  const rooms = db.prepare('SELECT id, name, capacity, is_lab FROM rooms WHERE branch_id = ?').all(branchId)
    .map((r) => ({ id: r.id, name: r.name, capacity: r.capacity, isLab: !!r.is_lab }));
  const teachers = db.prepare('SELECT id, name, available_days, max_per_day FROM teachers WHERE branch_id = ? AND active = 1').all(branchId)
    .map((t) => ({ id: t.id, name: t.name, days: t.available_days ? t.available_days.split(',').map(Number) : [] }));
  let classes = db.prepare(`
    SELECT c.id, c.subject, c.grade, c.teacher_id, c.needs_lab, c.preference,
           (SELECT COUNT(*) FROM enrollments e JOIN students s ON s.id = e.student_id
             WHERE e.class_id = c.id AND s.status = 'active') AS size
      FROM classes c WHERE c.branch_id = ? AND c.teacher_id IS NOT NULL`).all(branchId)
    .map((c) => ({ id: c.id, subject: c.subject, grade: c.grade, teacherId: c.teacher_id, size: Math.max(c.size, 1), needsLab: !!c.needs_lab, preference: c.preference }));
  if (grades && grades.length) classes = classes.filter((c) => grades.includes(c.grade));
  return { slots: slots(), rooms, teachers, classes, settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } };
}

// How good a timetable is, from 0 to 100, with the parts that make it up.
function scoreTimetable(problem, result) {
  const total = problem.classes.length || 1;
  const byId = new Map(problem.classes.map((c) => [c.id, c]));
  const roomById = new Map(problem.rooms.map((r) => [r.id, r]));
  const placed = result.assignments.filter((a) => byId.has(a.classId));
  const weekend = (d) => d >= 5;
  const prefOk = placed.filter((a) => {
    const p = byId.get(a.classId).preference;
    return p === 'any' || (p === 'weekend') === weekend(a.day);
  }).length;
  const util = placed.reduce((s, a) => s + byId.get(a.classId).size / roomById.get(a.roomId).capacity, 0);
  const perTeacher = new Map();
  for (const a of placed) {
    const t = perTeacher.get(a.teacherId) || { n: 0, days: new Set() };
    t.n++; t.days.add(a.day); perTeacher.set(a.teacherId, t);
  }
  const balance = [...perTeacher.values()].reduce((s, t) => s + t.days.size / t.n, 0);
  const parts = {
    placed: placed.length / total,
    preference: placed.length ? prefOk / placed.length : 0,
    roomUtilization: placed.length ? util / placed.length : 0,
    workloadBalance: perTeacher.size ? balance / perTeacher.size : 0,
  };
  const score = 100 * (0.4 * parts.placed + 0.2 * parts.preference + 0.2 * parts.roomUtilization + 0.2 * parts.workloadBalance);
  return { score: Math.round(score * 10) / 10, parts };
}

// Generate a timetable for a branch. When only some grades are chosen, the
// other grades keep their current sessions and the solver works around them.
async function generate(db, branchId, { grades, settings } = {}) {
  const full = loadProblem(db, branchId, { settings });
  const chosen = grades && grades.length ? full.classes.filter((c) => grades.includes(c.grade)) : full.classes;
  const chosenIds = new Set(chosen.map((c) => c.id));
  const classById = new Map(full.classes.map((c) => [c.id, c]));
  const kept = (grades && grades.length ? activeSessions(db, { branchId }) : [])
    .filter((s) => !chosenIds.has(s.class_id) && classById.has(s.class_id))
    .map((s) => ({ classId: s.class_id, grade: s.grade, teacherId: s.teacher_id, roomId: s.room_id, day: s.day, hour: s.hour, index: s.slot_index }));
  const keptIds = new Set(kept.map((k) => k.classId));
  const problem = { ...full, classes: chosen };
  const result = await scheduler.generate({ ...full, classes: chosen, fixed: kept, fixedClasses: full.classes.filter((c) => keptIds.has(c.id)) });
  const own = { ...result, assignments: result.assignments.filter((a) => !a.fixed) };
  const { score, parts } = scoreTimetable(problem, own);
  return { problem, result: own, kept, score, parts };
}

function saveTimetable(db, branchId, { week, settings, score, assignments, userId }) {
  return db.transaction(() => {
    db.prepare('UPDATE timetables SET is_active = 0 WHERE branch_id = ?').run(branchId);
    const tt = db.prepare(`INSERT INTO timetables (branch_id, week, priority, settings, score, is_active, created_at, created_by)
                           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(branchId, week, settings.priority || 'balanced', JSON.stringify(settings), score, nowStamp(), userId || null);
    const ins = db.prepare('INSERT INTO sessions (timetable_id, class_id, day, hour, slot_index, room_id) VALUES (?, ?, ?, ?, ?, ?)');
    for (const a of assignments) ins.run(tt.lastInsertRowid, a.classId, a.day, a.hour, a.index, a.roomId);
    return tt.lastInsertRowid;
  })();
}

function activeTimetable(db, branchId) {
  return db.prepare('SELECT * FROM timetables WHERE branch_id = ? AND is_active = 1').get(branchId);
}

const SESSION_SQL = `
  SELECT s.id, s.timetable_id, s.class_id, s.day, s.hour, s.slot_index, s.room_id,
         c.subject, c.grade, c.teacher_id, c.branch_id, c.needs_lab, c.preference,
         t.name AS teacher, r.name AS room, r.capacity,
         (SELECT COUNT(*) FROM enrollments e JOIN students st ON st.id = e.student_id
           WHERE e.class_id = c.id AND st.status = 'active') AS size
    FROM sessions s
    JOIN timetables tt ON tt.id = s.timetable_id AND tt.is_active = 1
    JOIN classes c ON c.id = s.class_id
    LEFT JOIN teachers t ON t.id = c.teacher_id
    JOIN rooms r ON r.id = s.room_id`;

// Sessions of the active timetables, optionally filtered.
function activeSessions(db, { branchId, day, teacherId, studentId, classIds } = {}) {
  const where = [], args = [];
  if (branchId) { where.push('c.branch_id = ?'); args.push(branchId); }
  if (day !== undefined && day !== null) { where.push('s.day = ?'); args.push(day); }
  if (teacherId) { where.push('c.teacher_id = ?'); args.push(teacherId); }
  if (studentId) { where.push('c.id IN (SELECT class_id FROM enrollments WHERE student_id = ?)'); args.push(studentId); }
  if (classIds) { where.push(`c.id IN (${classIds.map(() => '?').join(',') || 'NULL'})`); args.push(...classIds); }
  const sql = SESSION_SQL + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY s.day, s.hour, c.grade';
  return db.prepare(sql).all(...args);
}

// Check whether a session can move to another day / time / room.
async function checkMove(db, sessionId, { day, hour, roomId }) {
  const session = db.prepare(SESSION_SQL + ' WHERE s.id = ?').get(sessionId);
  if (!session) return null;
  const tt = db.prepare('SELECT * FROM timetables WHERE id = ?').get(session.timetable_id);
  const problem = loadProblem(db, session.branch_id, { settings: JSON.parse(tt.settings) });
  const others = activeSessions(db, { branchId: session.branch_id })
    .filter((s) => s.id !== session.id)
    .map((s) => ({ classId: s.class_id, grade: s.grade, teacherId: s.teacher_id, roomId: s.room_id, day: s.day, hour: s.hour, index: s.slot_index }));
  const issues = await scheduler.checkMove(problem, { classId: session.class_id, day, hour, roomId }, others);
  const index = (DAY_HOURS[day] || []).indexOf(hour);
  return { session, issues, index, reasons: issues.map((i) => REASONS[i] || i) };
}

/**
 * Minimal-disruption rescheduling: keep every session that is still valid and
 * let the solver re-place only the ones affected (e.g. a teacher became
 * unavailable on a day, or a room was removed).
 */
async function reschedule(db, branchId) {
  const tt = activeTimetable(db, branchId);
  if (!tt) return null;
  const settings = JSON.parse(tt.settings);
  const problem = loadProblem(db, branchId, { settings });
  const classById = new Map(problem.classes.map((c) => [c.id, c]));
  const teacherDays = new Map(problem.teachers.map((t) => [t.id, new Set(t.days)]));
  const roomById = new Map(problem.rooms.map((r) => [r.id, r]));
  const current = activeSessions(db, { branchId });
  const keep = [], affected = new Set();
  const used = new Set();
  for (const s of current) {
    const c = classById.get(s.class_id);
    const room = roomById.get(s.room_id);
    const ok = c && room && teacherDays.get(c.teacherId)?.has(s.day) && room.capacity >= c.size && (!c.needsLab || room.isLab)
      && !(settings.lunchBreak && s.hour === 12)
      && !used.has(`t${c.teacherId}-${s.day}-${s.hour}`) && !used.has(`r${s.room_id}-${s.day}-${s.hour}`) && !used.has(`g${c.grade}-${s.day}-${s.hour}`);
    if (ok) {
      keep.push({ classId: c.id, grade: c.grade, teacherId: c.teacherId, roomId: s.room_id, day: s.day, hour: s.hour, index: s.slot_index });
      used.add(`t${c.teacherId}-${s.day}-${s.hour}`); used.add(`r${s.room_id}-${s.day}-${s.hour}`); used.add(`g${c.grade}-${s.day}-${s.hour}`);
    } else if (c) affected.add(c.id);
  }
  // classes with no session at all (new classes) also need a place
  const scheduled = new Set(current.map((s) => s.class_id));
  for (const c of problem.classes) if (!scheduled.has(c.id)) affected.add(c.id);
  const keptIds = new Set(keep.map((k) => k.classId));
  const result = await scheduler.generate({
    ...problem,
    classes: problem.classes.filter((c) => affected.has(c.id)),
    fixedClasses: problem.classes.filter((c) => keptIds.has(c.id)),
    fixed: keep,
  });
  const { score } = scoreTimetable(problem, result);
  return { timetable: tt, settings, result, score, moved: [...affected], kept: keep.length };
}

module.exports = { DEFAULT_SETTINGS, REASONS, DAYS, loadProblem, scoreTimetable, generate, saveTimetable, activeTimetable, activeSessions, checkMove, reschedule };
