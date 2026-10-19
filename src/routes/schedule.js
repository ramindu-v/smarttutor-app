const express = require('express');
const crypto = require('crypto');
const timetable = require('../timetable');
const notify = require('../notify');
const { ah, requireRole, STAFF, int, csv, HttpError } = require('../http');
const { DAYS, DAY_HOURS } = require('../config');
const { isoWeek, today } = require('../util');

const PRIORITIES = ['balanced', 'workload', 'rooms', 'preference'];
const fmtHour = (h) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}`;

module.exports = (db) => {
  const r = express.Router();
  const previews = new Map(); // previewId -> generated timetable waiting to be published

  function enrich(problem, assignments) {
    const classes = new Map(db.prepare(`SELECT c.*, t.name AS teacher FROM classes c LEFT JOIN teachers t ON t.id = c.teacher_id`).all().map((c) => [c.id, c]));
    const rooms = new Map(db.prepare('SELECT * FROM rooms').all().map((x) => [x.id, x]));
    const size = new Map(problem.classes.map((c) => [c.id, c.size]));
    return assignments.map((a) => {
      const c = classes.get(a.classId), room = rooms.get(a.roomId);
      return { ...a, subject: c.subject, grade: c.grade, teacher: c.teacher, room: room.name, capacity: room.capacity, size: size.get(a.classId) };
    });
  }

  function describeUnplaced(unplaced) {
    return unplaced.map((u) => {
      const c = db.prepare('SELECT c.subject, c.grade, t.name AS teacher FROM classes c LEFT JOIN teachers t ON t.id = c.teacher_id WHERE c.id = ?').get(u.classId);
      return { ...u, ...c, message: timetable.REASONS[u.reason] || u.reason };
    });
  }

  function remember(preview) {
    const id = crypto.randomBytes(8).toString('hex');
    previews.set(id, { ...preview, createdAt: Date.now() });
    for (const [k, v] of previews) if (Date.now() - v.createdAt > 3600 * 1000) previews.delete(k);
    return id;
  }

  function readSettings(body) {
    return {
      priority: PRIORITIES.includes(body.priority) ? body.priority : 'balanced',
      maxPerDay: int(body.maxPerDay ?? 4, 'Max classes per teacher per day', { min: 1, max: 6 }),
      noBackToBack: body.noBackToBack !== false,
      lunchBreak: body.lunchBreak !== false,
    };
  }

  r.post('/generate', requireRole(...STAFF), ah(async (req, res) => {
    const branchId = int(req.body.branchId, 'Branch', { min: 1 });
    if (!db.prepare('SELECT 1 FROM branches WHERE id = ?').get(branchId)) throw new HttpError(404, 'Branch not found');
    const settings = readSettings(req.body);
    const grades = (Array.isArray(req.body.grades) ? req.body.grades : []).map((g) => int(g, 'Grade', { min: 6, max: 13 }));
    if (!grades.length) throw new HttpError(400, 'Choose at least one grade');
    const g = await timetable.generate(db, branchId, { grades, settings });
    const week = typeof req.body.week === 'string' && /^\d{4}-W\d{2}$/.test(req.body.week) ? req.body.week : isoWeek(today());
    const keep = g.kept; // grades that were not selected keep their current sessions
    const previewId = remember({ branchId, week, settings, score: g.score, assignments: [...g.result.assignments, ...keep] });
    res.json({
      previewId, week, settings, score: g.score, parts: g.parts, ms: g.result.ms,
      classes: g.problem.classes.length,
      assignments: enrich(g.problem, g.result.assignments),
      unplaced: describeUnplaced(g.result.unplaced),
      conflicts: g.result.conflicts,
      kept: keep.length,
    });
  }));

  r.post('/reschedule', requireRole(...STAFF), ah(async (req, res) => {
    const branchId = int(req.body.branchId, 'Branch', { min: 1 });
    const out = await timetable.reschedule(db, branchId);
    if (!out) throw new HttpError(400, 'This branch has no published timetable yet');
    const problem = timetable.loadProblem(db, branchId, { settings: out.settings });
    const previewId = remember({ branchId, week: out.timetable.week, settings: out.settings, score: out.score, assignments: out.result.assignments });
    res.json({
      previewId, week: out.timetable.week, settings: out.settings, score: out.score, ms: out.result.ms,
      kept: out.kept, moved: out.moved.length,
      assignments: enrich(problem, out.result.assignments),
      unplaced: describeUnplaced(out.result.unplaced),
      conflicts: out.result.conflicts,
    });
  }));

  r.post('/publish', requireRole(...STAFF), (req, res) => {
    const p = previews.get(String(req.body.previewId || ''));
    if (!p) throw new HttpError(400, 'This preview has expired. Generate the timetable again.');
    const before = new Map(timetable.activeSessions(db, { branchId: p.branchId }).map((s) => [s.class_id, `${s.day}-${s.hour}-${s.room_id}`]));
    const id = timetable.saveTimetable(db, p.branchId, { ...p, userId: req.user.id });
    previews.delete(String(req.body.previewId));
    // tell teachers and students whose classes changed
    const changed = p.assignments.filter((a) => before.get(a.classId) !== `${a.day}-${a.hour}-${a.roomId}`).map((a) => a.classId);
    const branch = db.prepare('SELECT name FROM branches WHERE id = ?').get(p.branchId).name;
    if (changed.length) {
      const marks = changed.map(() => '?').join(',');
      const teacherIds = db.prepare(`SELECT DISTINCT teacher_id FROM classes WHERE id IN (${marks})`).all(...changed).map((x) => x.teacher_id);
      const studentIds = db.prepare(`SELECT DISTINCT student_id FROM enrollments WHERE class_id IN (${marks})`).all(...changed).map((x) => x.student_id);
      const msg = { type: 'schedule', title: 'Timetable updated', body: `The ${branch} timetable for ${p.week} was updated. Some of your classes moved; check Schedule for the new times.` };
      notify.toTeachers(db, teacherIds, msg);
      notify.toStudents(db, studentIds, msg);
    }
    res.json({ timetableId: id, changed: changed.length });
  });

  r.get('/', requireRole(), (req, res) => {
    const opts = {};
    if (req.user.role === 'teacher' && !req.query.all) opts.teacherId = req.user.teacherId;
    if (req.user.role === 'student') opts.studentId = req.user.studentId;
    if (req.query.branch) opts.branchId = int(req.query.branch, 'Branch');
    const sessions = timetable.activeSessions(db, opts);
    const timetables = db.prepare(`SELECT tt.id, tt.branch_id, tt.week, tt.priority, tt.settings, tt.score, tt.created_at, u.name AS created_by
                                     FROM timetables tt LEFT JOIN users u ON u.id = tt.created_by WHERE tt.is_active = 1`).all()
      .map((t) => ({ ...t, settings: JSON.parse(t.settings) }));
    res.json({ sessions, timetables, days: DAYS, dayHours: DAY_HOURS });
  });

  function readMove(body) {
    const day = int(body.day, 'Day', { min: 0, max: 6 });
    const hour = int(body.hour, 'Time', { min: 0, max: 23 });
    const roomId = int(body.roomId, 'Room', { min: 1 });
    return { day, hour, roomId };
  }

  r.post('/sessions/:id/check', requireRole(...STAFF), ah(async (req, res) => {
    const out = await timetable.checkMove(db, int(req.params.id, 'Session'), readMove(req.body));
    if (!out) throw new HttpError(404, 'Class session not found');
    res.json({ ok: out.issues.length === 0, issues: out.issues, reasons: out.reasons });
  }));

  r.put('/sessions/:id', requireRole(...STAFF), ah(async (req, res) => {
    const move = readMove(req.body);
    const out = await timetable.checkMove(db, int(req.params.id, 'Session'), move);
    if (!out) throw new HttpError(404, 'Class session not found');
    if (out.issues.length) return res.status(409).json({ error: 'This move would break the timetable rules', issues: out.issues, reasons: out.reasons });
    db.prepare('UPDATE sessions SET day = ?, hour = ?, slot_index = ?, room_id = ? WHERE id = ?')
      .run(move.day, move.hour, out.index, move.roomId, out.session.id);
    const room = db.prepare('SELECT name FROM rooms WHERE id = ?').get(move.roomId).name;
    const msg = {
      type: 'schedule',
      title: `${out.session.subject} Grade ${out.session.grade} moved`,
      body: `Now on ${DAYS[move.day]} at ${fmtHour(move.hour)} in ${room} (was ${DAYS[out.session.day]} ${fmtHour(out.session.hour)}, ${out.session.room}).`,
    };
    notify.toTeachers(db, [out.session.teacher_id], msg);
    notify.toStudents(db, db.prepare('SELECT student_id FROM enrollments WHERE class_id = ?').all(out.session.class_id).map((e) => e.student_id), msg);
    res.json({ ok: true });
  }));

  r.get('/export.csv', requireRole(), (req, res) => {
    const opts = {};
    if (req.user.role === 'teacher') opts.teacherId = req.user.teacherId;
    if (req.user.role === 'student') opts.studentId = req.user.studentId;
    if (req.query.branch) opts.branchId = int(req.query.branch, 'Branch');
    const rows = timetable.activeSessions(db, opts).map((s) => ({
      Day: DAYS[s.day], Time: fmtHour(s.hour), Subject: s.subject, Grade: s.grade, Teacher: s.teacher, Room: s.room, Students: s.size,
    }));
    csv(res, 'timetable.csv', rows);
  });

  return r;
};
