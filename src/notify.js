// In-app notifications, plus messages for parents recorded in the outbox.
const { nowStamp } = require('./util');

function toUsers(db, userIds, { type, title, body }) {
  const ins = db.prepare('INSERT INTO notifications (user_id, type, title, body, created_at) VALUES (?, ?, ?, ?, ?)');
  const at = nowStamp();
  const unique = [...new Set(userIds.filter(Boolean))];
  db.transaction(() => { for (const id of unique) ins.run(id, type, title, body, at); })();
  return unique.length;
}

function toRoles(db, roles, message) {
  const ids = db.prepare(`SELECT id FROM users WHERE role IN (${roles.map(() => '?').join(',')})`).all(...roles).map((u) => u.id);
  return toUsers(db, ids, message);
}

function toTeachers(db, teacherIds, message) {
  if (!teacherIds.length) return 0;
  const ids = db.prepare(`SELECT id FROM users WHERE teacher_id IN (${teacherIds.map(() => '?').join(',')})`).all(...teacherIds).map((u) => u.id);
  return toUsers(db, ids, message);
}

function toStudents(db, studentIds, message) {
  if (!studentIds.length) return 0;
  const ids = db.prepare(`SELECT id FROM users WHERE student_id IN (${studentIds.map(() => '?').join(',')})`).all(...studentIds).map((u) => u.id);
  return toUsers(db, ids, message);
}

// SMS to a parent. The demo records it; a gateway would send it.
function smsParent(db, student, body) {
  if (!student.parent_phone) return false;
  db.prepare('INSERT INTO outbox (channel, recipient, body, created_at) VALUES (?, ?, ?, ?)')
    .run('sms', `${student.parent_name || 'Parent'} (${student.parent_phone})`, body, nowStamp());
  return true;
}

module.exports = { toUsers, toRoles, toTeachers, toStudents, smsParent };
