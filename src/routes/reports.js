const express = require('express');
const ml = require('../ml');
const timetable = require('../timetable');
const { requireRole, STAFF, csv } = require('../http');
const { today, addDays, dayIndex, monthOf, addMonths } = require('../util');
const { DAYS, DAY_HOURS, LUNCH_HOUR } = require('../config');

const RATE = "AVG(CASE WHEN a.status = 'absent' THEN 0.0 ELSE 1.0 END)";

function weeklyTrend(db, { weeks = 8, classIds } = {}) {
  const since = addDays(today(), -weeks * 7);
  const filter = classIds ? `AND a.class_id IN (${classIds.map(() => '?').join(',') || 'NULL'})` : '';
  return db.prepare(`SELECT strftime('%Y-W%W', a.date) AS week, MIN(a.date) AS start, ${RATE} AS rate, COUNT(*) AS records
                       FROM attendance a WHERE a.date >= ? ${filter} GROUP BY week ORDER BY week`).all(since, ...(classIds || []));
}

function revenue(db, months = 6) {
  const now = monthOf(today());
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const m = addMonths(now, -i);
    const collected = db.prepare('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE month = ?').get(m).v;
    const expected = db.prepare(`SELECT COALESCE(SUM(c.monthly_fee), 0) AS v FROM students s JOIN enrollments e ON e.student_id = s.id
                                  JOIN classes c ON c.id = e.class_id WHERE s.status = 'active' AND substr(s.joined_on, 1, 7) <= ?`).get(m).v;
    out.push({ month: m, collected, expected });
  }
  return out;
}

module.exports = (db) => {
  const r = express.Router();

  r.get('/overview', requireRole(...STAFF), (req, res) => {
    const bySubject = db.prepare(`SELECT c.subject, ${RATE} AS rate, COUNT(*) AS records FROM attendance a JOIN classes c ON c.id = a.class_id
                                   GROUP BY c.subject ORDER BY rate DESC`).all();
    const byGrade = db.prepare(`SELECT c.grade, ${RATE} AS rate FROM attendance a JOIN classes c ON c.id = a.class_id GROUP BY c.grade ORDER BY c.grade`).all();
    const sessions = timetable.activeSessions(db);
    const teachers = db.prepare('SELECT id, name, branch_id FROM teachers WHERE active = 1').all();
    const workload = teachers.map((t) => ({ name: t.name, sessions: sessions.filter((s) => s.teacher_id === t.id).length }))
      .sort((a, b) => b.sessions - a.sessions);
    const rooms = db.prepare('SELECT r.*, b.name AS branch FROM rooms r JOIN branches b ON b.id = r.branch_id').all();
    const usableSlots = Object.values(DAY_HOURS).reduce((s, hours) => s + hours.filter((h) => h !== LUNCH_HOUR).length, 0);
    const roomUse = rooms.map((room) => {
      const mine = sessions.filter((s) => s.room_id === room.id);
      return {
        room: room.name, branch: room.branch, capacity: room.capacity, sessions: mine.length,
        slotUse: mine.length / usableSlots,
        seatUse: mine.length ? mine.reduce((s, x) => s + x.size / room.capacity, 0) / mine.length : 0,
      };
    });
    const preds = [...ml.predictions(db).values()];
    res.json({
      weekly: weeklyTrend(db, { weeks: 10 }),
      bySubject, byGrade, workload, roomUse,
      revenue: revenue(db),
      risk: ['high', 'medium', 'low'].map((k) => ({ risk: k, count: preds.filter((p) => p.risk === k).length })),
      declining: preds.filter((p) => p.declining).length,
      model: ml.metrics(),
    });
  });

  r.post('/retrain', requireRole('admin'), (req, res) => {
    const m = ml.trainModel(db);
    ml.invalidate();
    res.json({ model: m });
  });

  r.get('/at-risk.csv', requireRole(...STAFF), (req, res) => {
    const rows = [...ml.predictions(db).values()].filter((p) => p.risk !== 'low').sort((a, b) => a.probability - b.probability)
      .map((p) => ({
        'Student ID': p.code, Name: p.name, Grade: p.grade, Risk: p.risk,
        'Predicted attendance': p.probability === null ? '' : (p.probability * 100).toFixed(0) + '%',
        'Attendance so far': p.rate === null ? '' : (p.rate * 100).toFixed(0) + '%',
        Declining: p.declining ? 'yes' : 'no',
      }));
    csv(res, 'at-risk-students.csv', rows);
  });

  r.get('/students.csv', requireRole(...STAFF), (req, res) => {
    const rows = db.prepare(`SELECT s.code AS "Student ID", s.name AS Name, s.grade AS Grade, b.name AS Branch, s.status AS Status,
                                    s.phone AS Phone, s.parent_name AS Parent, s.parent_phone AS "Parent phone", s.joined_on AS Joined,
                                    (SELECT GROUP_CONCAT(c.subject, '; ') FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = s.id) AS Subjects
                               FROM students s JOIN branches b ON b.id = s.branch_id ORDER BY s.code`).all();
    csv(res, 'students.csv', rows);
  });

  return r;
};

module.exports.dashboard = (db) => {
  const r = express.Router();

  r.get('/', requireRole(), (req, res) => {
    const t = today();
    const day = dayIndex(t);
    const u = req.user;
    const preds = ml.predictions(db);
    const notes = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 5').all(u.id);

    if (u.role === 'student') {
      const sessions = timetable.activeSessions(db, { studentId: u.studentId });
      const upcoming = [...sessions].sort((a, b) => ((a.day - day + 7) % 7) * 24 + a.hour - (((b.day - day + 7) % 7) * 24 + b.hour)).slice(0, 5);
      const p = ml.predictStudent(db, u.studentId);
      const m = monthOf(t);
      const fee = db.prepare('SELECT COALESCE(SUM(c.monthly_fee), 0) AS fee FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = ?').get(u.studentId).fee;
      const paid = db.prepare('SELECT * FROM payments WHERE student_id = ? AND month = ?').get(u.studentId, m);
      return res.json({
        role: u.role, today: t, day: DAYS[day], upcoming, prediction: p, notifications: notes,
        fees: { month: m, fee, paid: !!paid, receipt: paid?.receipt_no || null },
        classesPerWeek: sessions.length,
      });
    }

    const teacherFilter = u.role === 'teacher' ? { teacherId: u.teacherId } : {};
    const todays = timetable.activeSessions(db, { ...teacherFilter, day });
    const classIds = u.role === 'teacher' ? db.prepare('SELECT id FROM classes WHERE teacher_id = ?').all(u.teacherId).map((c) => c.id) : null;
    const visible = classIds
      ? new Set(db.prepare(`SELECT DISTINCT student_id FROM enrollments WHERE class_id IN (${classIds.map(() => '?').join(',') || 'NULL'})`).all(...classIds).map((x) => x.student_id))
      : null;
    const scoped = [...preds.values()].filter((p) => !visible || visible.has(p.id));
    const atRisk = scoped.filter((p) => p.risk === 'high' || p.declining).sort((a, b) => a.probability - b.probability).slice(0, 6)
      .map((p) => ({ id: p.id, name: p.name, code: p.code, grade: p.grade, probability: p.probability, rate: p.rate, declining: p.declining }));
    const base = {
      role: u.role, today: t, day: DAYS[day], todays, atRisk, notifications: notes,
      trend: weeklyTrend(db, { weeks: 8, classIds }),
    };
    if (u.role === 'teacher') {
      return res.json({
        ...base,
        stats: {
          classes: classIds.length,
          students: visible.size,
          sessionsPerWeek: timetable.activeSessions(db, teacherFilter).length,
          attendance: db.prepare(`SELECT ${RATE} AS r FROM attendance a WHERE a.class_id IN (${classIds.map(() => '?').join(',') || 'NULL'})`).get(...classIds).r,
        },
      });
    }
    const m = monthOf(t);
    const rev = revenue(db, 2);
    res.json({
      ...base,
      stats: {
        students: db.prepare("SELECT COUNT(*) AS n FROM students WHERE status = 'active'").get().n,
        newStudents: db.prepare('SELECT COUNT(*) AS n FROM students WHERE substr(joined_on, 1, 7) = ?').get(m).n,
        teachers: db.prepare('SELECT COUNT(*) AS n FROM teachers WHERE active = 1').get().n,
        sessionsPerWeek: timetable.activeSessions(db).length,
        todayCount: todays.length,
        revenue: rev[1].collected, revenueExpected: rev[1].expected, revenueLastMonth: rev[0].collected,
        attendance: db.prepare(`SELECT ${RATE} AS r FROM attendance a WHERE a.date >= ?`).get(addDays(t, -28)).r,
        unpaid: db.prepare(`SELECT COUNT(*) AS n FROM students s WHERE s.status = 'active' AND substr(s.joined_on, 1, 7) <= ?
                              AND EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id)
                              AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.student_id = s.id AND p.month = ?)`).get(m, m).n,
        highRisk: scoped.filter((p) => p.risk === 'high').length,
      },
      model: ml.metrics(),
    });
  });

  return r;
};
