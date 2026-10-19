// Which records a logged-in user may see.
const { HttpError } = require('./util');

function teacherClassIds(db, teacherId) {
  return db.prepare('SELECT id FROM classes WHERE teacher_id = ?').all(teacherId).map((c) => c.id);
}

function canSeeStudent(db, user, studentId) {
  if (user.role === 'admin' || user.role === 'coordinator') return true;
  if (user.role === 'student') return user.studentId === studentId;
  if (user.role === 'teacher') {
    return !!db.prepare(`SELECT 1 FROM enrollments e JOIN classes c ON c.id = e.class_id
                          WHERE e.student_id = ? AND c.teacher_id = ?`).get(studentId, user.teacherId);
  }
  return false;
}

function assertStudent(db, user, studentId) {
  if (!canSeeStudent(db, user, studentId)) throw new HttpError(403, 'You do not have access to this student');
}

function canManageClass(db, user, classId) {
  if (user.role === 'admin' || user.role === 'coordinator') return true;
  if (user.role === 'teacher') return !!db.prepare('SELECT 1 FROM classes WHERE id = ? AND teacher_id = ?').get(classId, user.teacherId);
  return false;
}

function assertClass(db, user, classId) {
  if (!db.prepare('SELECT 1 FROM classes WHERE id = ?').get(classId)) throw new HttpError(404, 'Class not found');
  if (!canManageClass(db, user, classId)) throw new HttpError(403, 'You do not teach this class');
}

module.exports = { teacherClassIds, canSeeStudent, assertStudent, canManageClass, assertClass };
