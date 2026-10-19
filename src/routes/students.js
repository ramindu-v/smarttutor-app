const express = require('express');
const ml = require('../ml');
const access = require('../access');
const { ah, requireRole, STAFF, int, text, isDate, HttpError } = require('../http');
const { today, hashPassword, monthOf } = require('../util');

module.exports = (db) => {
  const r = express.Router();

  const rates = () => new Map(db.prepare(`
    SELECT student_id, AVG(CASE WHEN status = 'absent' THEN 0.0 ELSE 1.0 END) AS rate, COUNT(*) AS n
      FROM attendance GROUP BY student_id`).all().map((x) => [x.student_id, x]));

  // List with filters. Teachers see the students in their own classes.
  r.get('/', requireRole('admin', 'coordinator', 'teacher'), (req, res) => {
    const where = [], args = [];
    if (req.user.role === 'teacher') {
      where.push('s.id IN (SELECT e.student_id FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE c.teacher_id = ?)');
      args.push(req.user.teacherId);
    }
    if (req.query.q) {
      where.push('(s.name LIKE ? OR s.code LIKE ?)');
      args.push(`%${req.query.q}%`, `%${req.query.q}%`);
    }
    if (req.query.grade) { where.push('s.grade = ?'); args.push(Number(req.query.grade)); }
    if (req.query.status) { where.push('s.status = ?'); args.push(String(req.query.status)); }
    if (req.query.branch) { where.push('s.branch_id = ?'); args.push(Number(req.query.branch)); }
    if (req.query.subject) {
      where.push('s.id IN (SELECT e.student_id FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE c.subject = ?)');
      args.push(String(req.query.subject));
    }
    const rows = db.prepare(`
      SELECT s.*, b.name AS branch,
             (SELECT GROUP_CONCAT(c.subject, ', ') FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = s.id) AS subjects
        FROM students s JOIN branches b ON b.id = s.branch_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY s.code`).all(...args);
    const rateMap = rates();
    const preds = ml.predictions(db);
    const thisMonth = monthOf(today());
    res.json({
      students: rows.map((s) => {
        const p = preds.get(s.id);
        return {
          ...s,
          attendanceRate: rateMap.get(s.id)?.rate ?? null,
          prediction: p ? { probability: p.probability, risk: p.risk, declining: p.declining } : null,
        };
      }),
      summary: {
        total: db.prepare('SELECT COUNT(*) AS n FROM students').get().n,
        active: db.prepare("SELECT COUNT(*) AS n FROM students WHERE status = 'active'").get().n,
        newThisMonth: db.prepare('SELECT COUNT(*) AS n FROM students WHERE substr(joined_on, 1, 7) = ?').get(thisMonth).n,
        averageAttendance: db.prepare("SELECT AVG(CASE WHEN status = 'absent' THEN 0.0 ELSE 1.0 END) AS r FROM attendance").get().r,
      },
    });
  });

  r.get('/:id', requireRole(), (req, res) => {
    const id = int(req.params.id, 'Student');
    access.assertStudent(db, req.user, id);
    const s = db.prepare('SELECT s.*, b.name AS branch FROM students s JOIN branches b ON b.id = s.branch_id WHERE s.id = ?').get(id);
    if (!s) throw new HttpError(404, 'Student not found');
    const classes = db.prepare(`
      SELECT c.id, c.subject, c.grade, c.monthly_fee, t.name AS teacher,
             (SELECT COUNT(*) FROM attendance a WHERE a.class_id = c.id AND a.student_id = e.student_id) AS sessions,
             (SELECT AVG(CASE WHEN status = 'absent' THEN 0.0 ELSE 1.0 END) FROM attendance a WHERE a.class_id = c.id AND a.student_id = e.student_id) AS rate
        FROM enrollments e JOIN classes c ON c.id = e.class_id LEFT JOIN teachers t ON t.id = c.teacher_id
       WHERE e.student_id = ? ORDER BY c.subject`).all(id);
    const batches = ml.batchRecommendations(db);
    const weekly = db.prepare(`
      SELECT strftime('%Y-%W', date) AS week, MIN(date) AS start,
             AVG(CASE WHEN status = 'absent' THEN 0.0 ELSE 1.0 END) AS rate, COUNT(*) AS n
        FROM attendance WHERE student_id = ? GROUP BY week ORDER BY week`).all(id);
    res.json({
      student: s,
      classes: classes.map((c) => ({ ...c, recommendation: batches.get(`${id}:${c.id}`) || null })),
      marks: db.prepare(`SELECT m.*, c.subject FROM marks m JOIN classes c ON c.id = m.class_id
                          WHERE m.student_id = ? ORDER BY c.subject, m.term`).all(id),
      attendance: db.prepare(`SELECT a.date, a.status, c.subject FROM attendance a JOIN classes c ON c.id = a.class_id
                               WHERE a.student_id = ? ORDER BY a.date DESC LIMIT 30`).all(id),
      weekly,
      payments: db.prepare('SELECT * FROM payments WHERE student_id = ? ORDER BY month DESC').all(id),
      prediction: ml.predictStudent(db, id),
      hasLogin: !!db.prepare('SELECT 1 FROM users WHERE student_id = ?').get(id),
    });
  });

  function readStudent(body) {
    const grade = int(body.grade, 'Grade', { min: 6, max: 13 });
    const branch = int(body.branch_id, 'Branch', { min: 1 });
    if (!db.prepare('SELECT 1 FROM branches WHERE id = ?').get(branch)) throw new HttpError(400, 'Branch not found');
    if (body.dob && !isDate(body.dob)) throw new HttpError(400, 'Date of birth is not valid');
    if (body.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) throw new HttpError(400, 'Email is not valid');
    const status = body.status === 'inactive' ? 'inactive' : 'active';
    return {
      name: text(body.name, 'Full name', { max: 100 }), dob: body.dob || null, grade, phone: text(body.phone, 'Phone', { optional: true, max: 30 }),
      email: text(body.email, 'Email', { optional: true, max: 120 }), parent_name: text(body.parent_name, 'Parent name', { optional: true, max: 100 }),
      parent_phone: text(body.parent_phone, 'Parent phone', { optional: true, max: 30 }), address: text(body.address, 'Address', { optional: true, max: 300 }),
      branch_id: branch, status,
    };
  }

  function setClasses(studentId, s, classIds) {
    const ids = (Array.isArray(classIds) ? classIds : []).map((c) => int(c, 'Class'));
    for (const cid of ids) {
      const c = db.prepare('SELECT * FROM classes WHERE id = ?').get(cid);
      if (!c) throw new HttpError(400, 'Class not found');
      if (c.grade !== s.grade || c.branch_id !== s.branch_id) throw new HttpError(400, `${c.subject} (Grade ${c.grade}) is not offered for this grade and branch`);
    }
    const existing = new Set(db.prepare('SELECT class_id FROM enrollments WHERE student_id = ?').all(studentId).map((e) => e.class_id));
    for (const cid of existing) if (!ids.includes(cid)) db.prepare('DELETE FROM enrollments WHERE student_id = ? AND class_id = ?').run(studentId, cid);
    for (const cid of ids) if (!existing.has(cid)) db.prepare('INSERT INTO enrollments (student_id, class_id, enrolled_on) VALUES (?, ?, ?)').run(studentId, cid, today());
  }

  function nextCode() {
    const last = db.prepare("SELECT code FROM students WHERE code LIKE 'ST%' ORDER BY code DESC LIMIT 1").get();
    const year = new Date().getFullYear();
    const n = last ? Number(last.code.slice(-3)) + 1 : 1;
    return `ST${year}${String(n).padStart(3, '0')}`;
  }

  r.post('/', requireRole('admin'), ah(async (req, res) => {
    const s = readStudent(req.body);
    const id = db.transaction(() => {
      let code = nextCode();
      while (db.prepare('SELECT 1 FROM students WHERE code = ?').get(code)) code = code.slice(0, -3) + String(Number(code.slice(-3)) + 1).padStart(3, '0');
      const info = db.prepare(`INSERT INTO students (code, name, dob, grade, phone, email, parent_name, parent_phone, address, branch_id, status, joined_on)
                               VALUES (@code, @name, @dob, @grade, @phone, @email, @parent_name, @parent_phone, @address, @branch_id, @status, @joined_on)`)
        .run({ ...s, code, joined_on: today() });
      setClasses(info.lastInsertRowid, s, req.body.classIds);
      if (req.body.password) {
        if (String(req.body.password).length < 6) throw new HttpError(400, 'Portal password must be at least 6 characters');
        db.prepare("INSERT INTO users (username, password_hash, role, name, student_id) VALUES (?, ?, 'student', ?, ?)")
          .run(code.toLowerCase(), hashPassword(String(req.body.password)), s.name, info.lastInsertRowid);
      }
      return info.lastInsertRowid;
    })();
    ml.invalidate();
    res.status(201).json({ student: db.prepare('SELECT * FROM students WHERE id = ?').get(id) });
  }));

  r.put('/:id', requireRole('admin'), ah(async (req, res) => {
    const id = int(req.params.id, 'Student');
    if (!db.prepare('SELECT 1 FROM students WHERE id = ?').get(id)) throw new HttpError(404, 'Student not found');
    const s = readStudent(req.body);
    db.transaction(() => {
      db.prepare(`UPDATE students SET name=@name, dob=@dob, grade=@grade, phone=@phone, email=@email, parent_name=@parent_name,
                  parent_phone=@parent_phone, address=@address, branch_id=@branch_id, status=@status WHERE id=@id`).run({ ...s, id });
      if (req.body.classIds) setClasses(id, s, req.body.classIds);
      db.prepare('UPDATE users SET name = ? WHERE student_id = ?').run(s.name, id);
    })();
    ml.invalidate();
    res.json({ student: db.prepare('SELECT * FROM students WHERE id = ?').get(id) });
  }));

  r.delete('/:id', requireRole('admin'), (req, res) => {
    const id = int(req.params.id, 'Student');
    const info = db.prepare('DELETE FROM students WHERE id = ?').run(id);
    if (!info.changes) throw new HttpError(404, 'Student not found');
    ml.invalidate();
    res.json({ ok: true });
  });

  // Term marks ("student progress recording"), by the class teacher or staff.
  r.post('/:id/marks', requireRole('admin', 'coordinator', 'teacher'), (req, res) => {
    const id = int(req.params.id, 'Student');
    const classId = int(req.body.classId, 'Class');
    access.assertClass(db, req.user, classId);
    if (!db.prepare('SELECT 1 FROM enrollments WHERE student_id = ? AND class_id = ?').get(id, classId)) throw new HttpError(400, 'The student is not in this class');
    const term = text(req.body.term, 'Term', { max: 30 });
    const score = int(req.body.score, 'Score', { min: 0, max: 100 });
    db.prepare(`INSERT INTO marks (student_id, class_id, term, score) VALUES (?, ?, ?, ?)
                ON CONFLICT (student_id, class_id, term) DO UPDATE SET score = excluded.score`).run(id, classId, term, score);
    res.json({ ok: true });
  });

  return r;
};
