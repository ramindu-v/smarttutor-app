const express = require('express');
const ml = require('../ml');
const access = require('../access');
const notify = require('../notify');
const timetable = require('../timetable');
const { ah, requireRole, STAFF, int, date, csv, isDate, HttpError } = require('../http');
const { dayIndex, today, addDays } = require('../util');
const { DAYS } = require('../config');

const STATUSES = ['present', 'absent', 'late'];

module.exports = (db) => {
  const r = express.Router();

  // Class sessions held on a date (from the published timetable).
  r.get('/sessions', requireRole('admin', 'coordinator', 'teacher'), (req, res) => {
    const d = date(req.query.date || today(), 'Date');
    const opts = { day: dayIndex(d) };
    if (req.user.role === 'teacher') opts.teacherId = req.user.teacherId;
    if (req.query.branch) opts.branchId = int(req.query.branch, 'Branch');
    const sessions = timetable.activeSessions(db, opts).map((s) => ({
      ...s,
      marked: db.prepare('SELECT COUNT(*) AS n FROM attendance WHERE class_id = ? AND date = ?').get(s.class_id, d).n,
    }));
    res.json({ date: d, day: DAYS[opts.day], sessions });
  });

  // Students of a class with their status on a date, history and prediction.
  r.get('/class/:classId', requireRole('admin', 'coordinator', 'teacher'), (req, res) => {
    const classId = int(req.params.classId, 'Class');
    access.assertClass(db, req.user, classId);
    const d = date(req.query.date || today(), 'Date');
    const klass = db.prepare('SELECT c.*, t.name AS teacher FROM classes c LEFT JOIN teachers t ON t.id = c.teacher_id WHERE c.id = ?').get(classId);
    const students = db.prepare(`
      SELECT s.id, s.code, s.name, s.parent_phone,
             (SELECT status FROM attendance a WHERE a.class_id = ? AND a.student_id = s.id AND a.date = ?) AS status,
             (SELECT AVG(CASE WHEN status = 'absent' THEN 0.0 ELSE 1.0 END) FROM attendance a WHERE a.class_id = ? AND a.student_id = s.id) AS rate
        FROM enrollments e JOIN students s ON s.id = e.student_id
       WHERE e.class_id = ? AND s.status = 'active' ORDER BY s.name`).all(classId, d, classId, classId);
    const turnout = ml.predictTurnout(db, classId);
    const probById = new Map((turnout?.students || []).map((p) => [p.studentId, p.probability]));
    const preds = ml.predictions(db);
    res.json({
      class: klass,
      date: d,
      students: students.map((s) => ({
        ...s,
        probability: probById.get(s.id) ?? null,
        risk: preds.get(s.id)?.risk || 'unknown',
        declining: preds.get(s.id)?.declining || false,
      })),
      turnout: turnout ? { enrolled: turnout.enrolled, expected: turnout.expected, rate: turnout.rate } : null,
    });
  });

  r.post('/', requireRole('admin', 'coordinator', 'teacher'), ah(async (req, res) => {
    const classId = int(req.body.classId, 'Class');
    access.assertClass(db, req.user, classId);
    const d = date(req.body.date, 'Date');
    if (d > today()) throw new HttpError(400, 'Attendance cannot be marked for a future date');
    const records = Array.isArray(req.body.records) ? req.body.records : [];
    if (!records.length) throw new HttpError(400, 'Mark at least one student');
    const klass = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
    const enrolled = new Set(db.prepare('SELECT student_id FROM enrollments WHERE class_id = ?').all(classId).map((e) => e.student_id));
    const clean = records.map((x) => {
      const studentId = int(x.studentId, 'Student');
      if (!enrolled.has(studentId)) throw new HttpError(400, 'A student is not in this class');
      if (!STATUSES.includes(x.status)) throw new HttpError(400, 'Status must be present, absent or late');
      return { studentId, status: x.status };
    });
    const previous = new Map(db.prepare('SELECT student_id, status FROM attendance WHERE class_id = ? AND date = ?').all(classId, d).map((a) => [a.student_id, a.status]));
    db.transaction(() => {
      const up = db.prepare(`INSERT INTO attendance (class_id, student_id, date, status, marked_by) VALUES (?, ?, ?, ?, ?)
                             ON CONFLICT (class_id, student_id, date) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by`);
      for (const x of clean) up.run(classId, x.studentId, d, x.status, req.user.id);
    })();
    // newly absent students: tell the student and send the parent an SMS
    let parentsNotified = 0;
    for (const x of clean.filter((c) => c.status === 'absent' && previous.get(c.studentId) !== 'absent')) {
      const s = db.prepare('SELECT * FROM students WHERE id = ?').get(x.studentId);
      const body = `${s.name} was absent from ${klass.subject} (Grade ${klass.grade}) on ${d}. - FutureMinds`;
      notify.toStudents(db, [s.id], { type: 'attendance', title: `Absent: ${klass.subject}`, body });
      if (notify.smsParent(db, s, body)) parentsNotified++;
    }
    ml.retrainSoon(db);
    const counts = Object.fromEntries(STATUSES.map((st) => [st, clean.filter((c) => c.status === st).length]));
    res.json({ ok: true, saved: clean.length, counts, parentsNotified });
  }));

  // A student's own attendance history.
  r.get('/student/:id', requireRole(), (req, res) => {
    const id = int(req.params.id, 'Student');
    access.assertStudent(db, req.user, id);
    const rows = db.prepare(`SELECT a.date, a.status, c.subject, c.grade FROM attendance a JOIN classes c ON c.id = a.class_id
                              WHERE a.student_id = ? ORDER BY a.date DESC, c.subject`).all(id);
    const bySubject = db.prepare(`SELECT c.subject, COUNT(*) AS sessions,
                                    SUM(a.status = 'present') AS present, SUM(a.status = 'late') AS late, SUM(a.status = 'absent') AS absent
                                    FROM attendance a JOIN classes c ON c.id = a.class_id WHERE a.student_id = ? GROUP BY c.subject`).all(id);
    res.json({ records: rows, bySubject, prediction: ml.predictStudent(db, id) });
  });

  // Patterns the AI insights panel shows.
  r.get('/insights', requireRole('admin', 'coordinator', 'teacher'), (req, res) => {
    const classFilter = req.user.role === 'teacher' ? access.teacherClassIds(db, req.user.teacherId) : null;
    const inClasses = classFilter ? `AND a.class_id IN (${classFilter.map(() => '?').join(',') || 'NULL'})` : '';
    const args = classFilter || [];
    const since = addDays(today(), -56);
    const byDay = db.prepare(`SELECT a.date, AVG(CASE WHEN status = 'absent' THEN 0.0 ELSE 1.0 END) AS rate, COUNT(*) AS n
                                FROM attendance a WHERE a.date >= ? ${inClasses} GROUP BY a.date`).all(since, ...args);
    const weekday = DAYS.map((name, i) => {
      const rows = byDay.filter((x) => dayIndex(x.date) === i);
      const n = rows.reduce((s, x) => s + x.n, 0);
      return { day: name, rate: n ? rows.reduce((s, x) => s + x.rate * x.n, 0) / n : null, records: n };
    });
    const overall = byDay.reduce((s, x) => s + x.rate * x.n, 0) / (byDay.reduce((s, x) => s + x.n, 0) || 1);
    const visible = classFilter
      ? new Set(db.prepare(`SELECT DISTINCT student_id FROM enrollments WHERE class_id IN (${classFilter.map(() => '?').join(',') || 'NULL'})`).all(...classFilter).map((x) => x.student_id))
      : null;
    const preds = [...ml.predictions(db).values()].filter((p) => !visible || visible.has(p.id));
    const atRisk = preds.filter((p) => p.risk === 'high' || p.declining).sort((a, b) => a.probability - b.probability).slice(0, 8)
      .map((p) => ({ id: p.id, code: p.code, name: p.name, grade: p.grade, probability: p.probability, rate: p.rate, recentRate: p.recentRate, declining: p.declining, risk: p.risk }));
    res.json({
      overall,
      weekday,
      atRisk,
      highPerformers: preds.filter((p) => p.rate !== null && p.rate >= 0.95).length,
      riskCounts: ['high', 'medium', 'low'].map((k) => ({ risk: k, count: preds.filter((p) => p.risk === k).length })),
      model: ml.metrics(),
    });
  });

  r.get('/export.csv', requireRole('admin', 'coordinator', 'teacher'), (req, res) => {
    const where = [], args = [];
    if (req.query.classId) {
      const classId = int(req.query.classId, 'Class');
      access.assertClass(db, req.user, classId);
      where.push('a.class_id = ?'); args.push(classId);
    } else if (req.user.role === 'teacher') {
      where.push('c.teacher_id = ?'); args.push(req.user.teacherId);
    }
    if (isDate(req.query.from)) { where.push('a.date >= ?'); args.push(req.query.from); }
    if (isDate(req.query.to)) { where.push('a.date <= ?'); args.push(req.query.to); }
    const rows = db.prepare(`SELECT a.date AS Date, c.subject AS Subject, c.grade AS Grade, s.code AS "Student ID", s.name AS Student, a.status AS Status
                               FROM attendance a JOIN classes c ON c.id = a.class_id JOIN students s ON s.id = a.student_id
                              ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.date DESC, c.subject, s.name`).all(...args);
    csv(res, 'attendance.csv', rows);
  });

  return r;
};
