const crypto = require('crypto');
const { verifyPassword } = require('./util');

const COOKIE = 'st_session';
const TTL_MS = 7 * 24 * 3600 * 1000;

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, name: u.name, teacherId: u.teacher_id, studentId: u.student_id };
}

function login(db, username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, Date.now() + TTL_MS);
  return { token, user };
}

function middleware(db) {
  const find = db.prepare(`SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token = ? AND s.expires_at > ?`);
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const user = token ? find.get(token, Date.now()) : null;
    req.user = user ? publicUser(user) : null;
    req.sessionToken = user ? token : null;
    next();
  };
}

function setCookie(res, token, secure) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure ? '; Secure' : ''}`);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = { login, middleware, setCookie, clearCookie, publicUser };
