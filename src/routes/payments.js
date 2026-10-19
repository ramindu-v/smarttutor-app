const express = require('express');
const notify = require('../notify');
const access = require('../access');
const { ah, requireRole, int, text, month, csv, HttpError } = require('../http');
const { today, monthOf } = require('../util');

const METHODS = ['cash', 'bank transfer', 'card', 'online'];

module.exports = (db) => {
  const r = express.Router();

  const feeOf = db.prepare(`SELECT COALESCE(SUM(c.monthly_fee), 0) AS fee FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = ?`);

  r.get('/', requireRole('admin', 'student'), (req, res) => {
    const where = [], args = [];
    if (req.user.role === 'student') { where.push('p.student_id = ?'); args.push(req.user.studentId); }
    if (req.query.month) { where.push('p.month = ?'); args.push(month(req.query.month, 'Month')); }
    if (req.query.q) { where.push('(s.name LIKE ? OR s.code LIKE ? OR p.receipt_no LIKE ?)'); args.push(...Array(3).fill(`%${req.query.q}%`)); }
    const rows = db.prepare(`SELECT p.*, s.name AS student, s.code, s.grade, u.name AS recorded_by_name
                               FROM payments p JOIN students s ON s.id = p.student_id LEFT JOIN users u ON u.id = p.recorded_by
                              ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.paid_on DESC, p.id DESC LIMIT 500`).all(...args);
    res.json({ payments: rows });
  });

  // Who owes what for a month.
  r.get('/dues', requireRole('admin', 'student'), (req, res) => {
    const m = req.query.month ? month(req.query.month, 'Month') : monthOf(today());
    const filter = req.user.role === 'student' ? 'AND s.id = ?' : '';
    const rows = db.prepare(`
      SELECT s.id, s.code, s.name, s.grade, s.parent_phone, b.name AS branch,
             (SELECT COALESCE(SUM(c.monthly_fee), 0) FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = s.id) AS fee,
             p.id AS payment_id, p.receipt_no, p.amount, p.paid_on
        FROM students s JOIN branches b ON b.id = s.branch_id
        LEFT JOIN payments p ON p.student_id = s.id AND p.month = ?
       WHERE s.status = 'active' AND substr(s.joined_on, 1, 7) <= ? ${filter}
       ORDER BY (p.id IS NOT NULL), s.code`).all(m, m, ...(req.user.role === 'student' ? [req.user.studentId] : []));
    const due = rows.filter((x) => x.fee > 0);
    const paid = due.filter((x) => x.payment_id);
    res.json({
      month: m,
      rows: due,
      summary: {
        students: due.length, paid: paid.length, unpaid: due.length - paid.length,
        expected: due.reduce((s, x) => s + x.fee, 0), collected: paid.reduce((s, x) => s + x.amount, 0),
      },
    });
  });

  r.post('/', requireRole('admin'), ah(async (req, res) => {
    const studentId = int(req.body.studentId, 'Student');
    const s = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
    if (!s) throw new HttpError(404, 'Student not found');
    const m = month(req.body.month, 'Month');
    const amount = int(req.body.amount ?? feeOf.get(studentId).fee, 'Amount', { min: 1, max: 1000000 });
    const method = METHODS.includes(req.body.method) ? req.body.method : 'cash';
    if (db.prepare('SELECT 1 FROM payments WHERE student_id = ? AND month = ?').get(studentId, m)) throw new HttpError(409, `${s.name} has already paid for ${m}`);
    const id = db.transaction(() => {
      const seq = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE month = ?').get(m).n + 1;
      let receipt = `RC-${m.replace('-', '')}-${String(seq).padStart(5, '0')}`;
      for (let k = seq + 1; db.prepare('SELECT 1 FROM payments WHERE receipt_no = ?').get(receipt); k++) receipt = `RC-${m.replace('-', '')}-${String(k).padStart(5, '0')}`;
      return db.prepare('INSERT INTO payments (receipt_no, student_id, month, amount, method, paid_on, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(receipt, studentId, m, amount, method, today(), req.user.id).lastInsertRowid;
    })();
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    notify.toStudents(db, [studentId], { type: 'payment', title: 'Payment received', body: `Rs ${amount.toLocaleString('en-US')} received for ${m}. Receipt ${p.receipt_no}.` });
    res.status(201).json({ payment: p });
  }));

  r.delete('/:id', requireRole('admin'), (req, res) => {
    const info = db.prepare('DELETE FROM payments WHERE id = ?').run(int(req.params.id, 'Payment'));
    if (!info.changes) throw new HttpError(404, 'Payment not found');
    res.json({ ok: true });
  });

  r.get('/:id/receipt', requireRole('admin', 'student'), (req, res) => {
    const p = db.prepare(`SELECT p.*, s.name AS student, s.code, s.grade, s.parent_name, b.name AS branch, u.name AS recorded_by_name
                            FROM payments p JOIN students s ON s.id = p.student_id JOIN branches b ON b.id = s.branch_id
                            LEFT JOIN users u ON u.id = p.recorded_by WHERE p.id = ?`).get(int(req.params.id, 'Payment'));
    if (!p) throw new HttpError(404, 'Payment not found');
    access.assertStudent(db, req.user, p.student_id);
    const items = db.prepare(`SELECT c.subject, c.grade, c.monthly_fee FROM enrollments e JOIN classes c ON c.id = e.class_id
                               WHERE e.student_id = ? ORDER BY c.subject`).all(p.student_id);
    res.json({ payment: p, items });
  });

  // Payment reminders to students and their parents for an unpaid month.
  r.post('/reminders', requireRole('admin'), (req, res) => {
    const m = month(req.body.month || monthOf(today()), 'Month');
    const unpaid = db.prepare(`
      SELECT s.*, (SELECT COALESCE(SUM(c.monthly_fee), 0) FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = s.id) AS fee
        FROM students s WHERE s.status = 'active' AND substr(s.joined_on, 1, 7) <= ?
         AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.student_id = s.id AND p.month = ?)`).all(m, m).filter((s) => s.fee > 0);
    let sms = 0;
    for (const s of unpaid) {
      const body = `Reminder: tuition fee of Rs ${s.fee.toLocaleString('en-US')} for ${m} is due for ${s.name}. - FutureMinds`;
      notify.toStudents(db, [s.id], { type: 'payment', title: `Fee due for ${m}`, body });
      if (notify.smsParent(db, s, body)) sms++;
    }
    res.json({ reminded: unpaid.length, sms });
  });

  r.get('/export.csv', requireRole('admin'), (req, res) => {
    const rows = db.prepare(`SELECT p.receipt_no AS Receipt, p.paid_on AS "Paid on", p.month AS Month, s.code AS "Student ID", s.name AS Student,
                                    p.amount AS "Amount (Rs)", p.method AS Method
                               FROM payments p JOIN students s ON s.id = p.student_id ORDER BY p.paid_on DESC`).all();
    csv(res, 'payments.csv', rows);
  });

  return r;
};
