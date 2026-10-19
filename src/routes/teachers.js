const express = require('express');
const notify = require('../notify');
const { ah, requireRole, STAFF, int, text, HttpError } = require('../http');
const { SUBJECTS, DAYS, LAB_SUBJECTS } = require('../config');
const { hashPassword } = require('../util');

module.exports = (db) => {
  const r = express.Router();

  const withWorkload = (t) => {
    const classes = db.prepare(`SELECT c.id, c.subject, c.grade,
                                  (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id) AS size
                                  FROM classes c WHERE c.teacher_id = ? ORDER BY c.grade, c.subject`).all(t.id);
    const sessions = db.prepare(`SELECT s.day, s.hour FROM sessions s JOIN timetables tt ON tt.id = s.timetable_id AND tt.is_active = 1
                                   JOIN classes c ON c.id = s.class_id WHERE c.teacher_id = ?`).all(t.id);
    return {
      ...t,
      subjects: t.subjects ? t.subjects.split(',') : [],
      available_days: t.available_days ? t.available_days.split(',').map(Number) : [],
      classes,
      weeklySessions: sessions.length,
      weeklyHours: sessions.length * 2,
      hasLogin: !!db.prepare('SELECT 1 FROM users WHERE teacher_id = ?').get(t.id),
    };
  };

  r.get('/', requireRole(...STAFF), (req, res) => {
    const rows = db.prepare('SELECT t.*, b.name AS branch FROM teachers t JOIN branches b ON b.id = t.branch_id ORDER BY t.branch_id, t.name').all();
    res.json({ teachers: rows.map(withWorkload) });
  });

  r.get('/me', requireRole('teacher'), (req, res) => {
    const t = db.prepare('SELECT t.*, b.name AS branch FROM teachers t JOIN branches b ON b.id = t.branch_id WHERE t.id = ?').get(req.user.teacherId);
    res.json({ teacher: withWorkload(t) });
  });

  function readDays(days) {
    const list = (Array.isArray(days) ? days : []).map((d) => int(d, 'Day', { min: 0, max: 6 }));
    return [...new Set(list)].sort().join(',');
  }

  function readTeacher(body) {
    const subjects = (Array.isArray(body.subjects) ? body.subjects : []).map(String);
    if (!subjects.length) throw new HttpError(400, 'Choose at least one subject');
    for (const s of subjects) if (!SUBJECTS.includes(s)) throw new HttpError(400, `Unknown subject ${s}`);
    const branch = int(body.branch_id, 'Branch', { min: 1 });
    if (!db.prepare('SELECT 1 FROM branches WHERE id = ?').get(branch)) throw new HttpError(400, 'Branch not found');
    return {
      name: text(body.name, 'Name', { max: 100 }),
      email: text(body.email, 'Email', { optional: true, max: 120 }),
      phone: text(body.phone, 'Phone', { optional: true, max: 30 }),
      subjects: subjects.join(','),
      available_days: readDays(body.available_days),
      max_per_day: int(body.max_per_day ?? 4, 'Max classes per day', { min: 1, max: 6 }),
      branch_id: branch,
      active: body.active === false ? 0 : 1,
    };
  }

  r.post('/', requireRole('admin'), ah(async (req, res) => {
    const t = readTeacher(req.body);
    const id = db.transaction(() => {
      const info = db.prepare(`INSERT INTO teachers (name, email, phone, subjects, available_days, max_per_day, branch_id, active)
                               VALUES (@name, @email, @phone, @subjects, @available_days, @max_per_day, @branch_id, @active)`).run(t);
      if (req.body.username && req.body.password) {
        if (String(req.body.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
        if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(String(req.body.username))) throw new HttpError(400, 'That username is taken');
        db.prepare("INSERT INTO users (username, password_hash, role, name, teacher_id) VALUES (?, ?, 'teacher', ?, ?)")
          .run(String(req.body.username).trim().toLowerCase(), hashPassword(String(req.body.password)), t.name, info.lastInsertRowid);
      }
      return info.lastInsertRowid;
    })();
    res.status(201).json({ teacher: withWorkload(db.prepare('SELECT * FROM teachers WHERE id = ?').get(id)) });
  }));

  r.put('/:id', requireRole(...STAFF), (req, res) => {
    const id = int(req.params.id, 'Teacher');
    const before = db.prepare('SELECT * FROM teachers WHERE id = ?').get(id);
    if (!before) throw new HttpError(404, 'Teacher not found');
    const t = readTeacher(req.body);
    db.prepare(`UPDATE teachers SET name=@name, email=@email, phone=@phone, subjects=@subjects, available_days=@available_days,
                max_per_day=@max_per_day, branch_id=@branch_id, active=@active WHERE id=@id`).run({ ...t, id });
    db.prepare('UPDATE users SET name = ? WHERE teacher_id = ?').run(t.name, id);
    if (before.available_days !== t.available_days) availabilityChanged(id, t.name, t.available_days);
    res.json({ teacher: withWorkload(db.prepare('SELECT * FROM teachers WHERE id = ?').get(id)) });
  });

  // Teachers update their own availability.
  r.put('/me/availability', requireRole('teacher'), (req, res) => {
    const days = readDays(req.body.available_days);
    const t = db.prepare('SELECT * FROM teachers WHERE id = ?').get(req.user.teacherId);
    db.prepare('UPDATE teachers SET available_days = ? WHERE id = ?').run(days, t.id);
    if (t.available_days !== days) availabilityChanged(t.id, t.name, days);
    res.json({ ok: true, available_days: days ? days.split(',').map(Number) : [] });
  });

  function availabilityChanged(teacherId, name, days) {
    const list = days ? days.split(',').map((d) => DAYS[d]).join(', ') : 'no days';
    const clashes = db.prepare(`SELECT COUNT(*) AS n FROM sessions s JOIN timetables tt ON tt.id = s.timetable_id AND tt.is_active = 1
                                  JOIN classes c ON c.id = s.class_id WHERE c.teacher_id = ? AND (',' || ? || ',') NOT LIKE ('%,' || s.day || ',%')`)
      .get(teacherId, days).n;
    notify.toRoles(db, ['admin', 'coordinator'], {
      type: 'availability',
      title: `${name} changed availability`,
      body: `Now available on ${list}.` + (clashes ? ` ${clashes} scheduled class(es) fall on days they are no longer available. Use "Reschedule affected classes" on the Schedule page.` : ''),
    });
  }

  r.delete('/:id', requireRole('admin'), (req, res) => {
    const id = int(req.params.id, 'Teacher');
    const info = db.prepare('DELETE FROM teachers WHERE id = ?').run(id);
    if (!info.changes) throw new HttpError(404, 'Teacher not found');
    res.json({ ok: true });
  });

  return r;
};

module.exports.classes = (db) => {
  const r = express.Router();

  r.get('/', requireRole(), (req, res) => {
    const where = [], args = [];
    if (req.query.branch) { where.push('c.branch_id = ?'); args.push(Number(req.query.branch)); }
    if (req.query.grade) { where.push('c.grade = ?'); args.push(Number(req.query.grade)); }
    if (req.user.role === 'teacher' && req.query.mine) { where.push('c.teacher_id = ?'); args.push(req.user.teacherId); }
    const rows = db.prepare(`
      SELECT c.*, t.name AS teacher, b.name AS branch,
             (SELECT COUNT(*) FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.class_id = c.id AND s.status = 'active') AS size
        FROM classes c LEFT JOIN teachers t ON t.id = c.teacher_id JOIN branches b ON b.id = c.branch_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.branch_id, c.grade, c.subject`).all(...args);
    res.json({ classes: rows });
  });

  function readClass(body) {
    const subject = text(body.subject, 'Subject');
    if (!SUBJECTS.includes(subject)) throw new HttpError(400, 'Unknown subject');
    const grade = int(body.grade, 'Grade', { min: 6, max: 13 });
    const branch = int(body.branch_id, 'Branch', { min: 1 });
    const teacherId = int(body.teacher_id, 'Teacher', { optional: true });
    if (teacherId) {
      const t = db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId);
      if (!t) throw new HttpError(400, 'Teacher not found');
      if (t.branch_id !== branch) throw new HttpError(400, 'The teacher works at a different branch');
    }
    const preference = ['any', 'weekday', 'weekend'].includes(body.preference) ? body.preference : 'any';
    return {
      subject, grade, branch_id: branch, teacher_id: teacherId,
      monthly_fee: int(body.monthly_fee, 'Monthly fee', { min: 0, max: 100000 }),
      needs_lab: body.needs_lab === undefined ? (grade >= 12 && LAB_SUBJECTS.includes(subject) ? 1 : 0) : (body.needs_lab ? 1 : 0),
      preference,
    };
  }

  r.post('/', requireRole(...STAFF), (req, res) => {
    const c = readClass(req.body);
    const info = db.prepare(`INSERT INTO classes (subject, grade, teacher_id, branch_id, monthly_fee, needs_lab, preference)
                             VALUES (@subject, @grade, @teacher_id, @branch_id, @monthly_fee, @needs_lab, @preference)`).run(c);
    res.status(201).json({ class: db.prepare('SELECT * FROM classes WHERE id = ?').get(info.lastInsertRowid) });
  });

  r.put('/:id', requireRole(...STAFF), (req, res) => {
    const id = int(req.params.id, 'Class');
    if (!db.prepare('SELECT 1 FROM classes WHERE id = ?').get(id)) throw new HttpError(404, 'Class not found');
    const c = readClass(req.body);
    db.prepare(`UPDATE classes SET subject=@subject, grade=@grade, teacher_id=@teacher_id, branch_id=@branch_id,
                monthly_fee=@monthly_fee, needs_lab=@needs_lab, preference=@preference WHERE id=@id`).run({ ...c, id });
    res.json({ class: db.prepare('SELECT * FROM classes WHERE id = ?').get(id) });
  });

  r.delete('/:id', requireRole('admin'), (req, res) => {
    const id = int(req.params.id, 'Class');
    const info = db.prepare('DELETE FROM classes WHERE id = ?').run(id);
    if (!info.changes) throw new HttpError(404, 'Class not found');
    res.json({ ok: true });
  });

  return r;
};
