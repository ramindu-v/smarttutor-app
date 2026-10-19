const express = require('express');
const notify = require('../notify');
const { requireRole, STAFF, text, HttpError } = require('../http');
const { nowStamp } = require('../util');

module.exports = (db) => {
  const r = express.Router();

  r.get('/', requireRole(), (req, res) => {
    const items = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(req.user.id);
    const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n;
    res.json({ notifications: items, unread });
  });

  r.post('/read-all', requireRole(), (req, res) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(nowStamp(), req.user.id);
    res.json({ ok: true });
  });

  r.post('/:id/read', requireRole(), (req, res) => {
    db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').run(nowStamp(), Number(req.params.id), req.user.id);
    res.json({ ok: true });
  });

  r.post('/send', requireRole(...STAFF), (req, res) => {
    const title = text(req.body.title, 'Title', { max: 120 });
    const body = text(req.body.body, 'Message', { max: 1000 });
    const audiences = { everyone: ['admin', 'coordinator', 'teacher', 'student'], teachers: ['teacher'], students: ['student'], staff: ['admin', 'coordinator'] };
    const roles = audiences[req.body.audience];
    if (!roles) throw new HttpError(400, 'Choose who should receive it');
    const sent = notify.toRoles(db, roles, { type: 'announcement', title, body: `${body}\n- ${req.user.name}` });
    res.json({ sent });
  });

  r.get('/outbox', requireRole(...STAFF), (req, res) => {
    res.json({ messages: db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 200').all() });
  });

  return r;
};
