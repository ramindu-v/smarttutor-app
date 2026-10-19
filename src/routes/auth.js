const express = require('express');
const auth = require('../auth');
const { ah, requireRole, text, HttpError } = require('../http');
const { verifyPassword, hashPassword } = require('../util');

module.exports = (db, { secureCookies }) => {
  const r = express.Router();

  // simple brute-force guard: 10 failed attempts per username per 10 minutes
  const failures = new Map();
  r.post('/login', ah(async (req, res) => {
    const username = text(req.body.username, 'Username').toLowerCase();
    const recent = (failures.get(username) || []).filter((t) => Date.now() - t < 10 * 60 * 1000);
    if (recent.length >= 10) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const result = auth.login(db, username, text(req.body.password, 'Password'));
    if (!result) {
      failures.set(username, [...recent, Date.now()]);
      throw new HttpError(401, 'Wrong username or password');
    }
    failures.delete(username);
    auth.setCookie(res, result.token, secureCookies);
    res.json({ user: auth.publicUser(result.user) });
  }));

  r.post('/logout', (req, res) => {
    if (req.sessionToken) db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(req.sessionToken);
    auth.clearCookie(res);
    res.json({ ok: true });
  });

  r.get('/me', requireRole(), (req, res) => res.json({ user: req.user }));
  // like /me but never 401, for the login page
  r.get('/session', (req, res) => res.json({ user: req.user }));

  r.post('/password', requireRole(), ah(async (req, res) => {
    const current = text(req.body.current, 'Current password');
    const next = text(req.body.next, 'New password');
    if (next.length < 6) throw new HttpError(400, 'The new password must be at least 6 characters');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(current, user.password_hash)) throw new HttpError(400, 'Current password is wrong');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token != ?').run(user.id, req.sessionToken);
    res.json({ ok: true });
  }));

  return r;
};
