const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  is_lab INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  subjects TEXT NOT NULL DEFAULT '',          -- comma separated
  available_days TEXT NOT NULL DEFAULT '',    -- comma separated day numbers, 0 = Monday
  max_per_day INTEGER NOT NULL DEFAULT 4,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  dob TEXT,
  grade INTEGER NOT NULL CHECK (grade BETWEEN 6 AND 13),
  phone TEXT,
  email TEXT,
  parent_name TEXT,
  parent_phone TEXT,
  address TEXT,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  joined_on TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  subject TEXT NOT NULL,
  grade INTEGER NOT NULL,
  teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  monthly_fee INTEGER NOT NULL DEFAULT 0,
  needs_lab INTEGER NOT NULL DEFAULT 0,
  preference TEXT NOT NULL DEFAULT 'any' CHECK (preference IN ('any', 'weekday', 'weekend'))
);
CREATE TABLE IF NOT EXISTS enrollments (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  enrolled_on TEXT NOT NULL,
  PRIMARY KEY (student_id, class_id)
);
CREATE TABLE IF NOT EXISTS timetables (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  week TEXT NOT NULL,
  priority TEXT NOT NULL,
  settings TEXT NOT NULL,
  score REAL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  timetable_id INTEGER NOT NULL REFERENCES timetables(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  slot_index INTEGER NOT NULL,
  room_id INTEGER NOT NULL REFERENCES rooms(id)
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late')),
  marked_by INTEGER REFERENCES users(id),
  UNIQUE (class_id, student_id, date)
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                          -- YYYY-MM the fee is for
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL DEFAULT 'cash',
  paid_on TEXT NOT NULL,
  recorded_by INTEGER REFERENCES users(id),
  UNIQUE (student_id, month)
);
CREATE TABLE IF NOT EXISTS marks (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  UNIQUE (student_id, class_id, term)
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'coordinator', 'teacher', 'student')),
  name TEXT NOT NULL,
  teacher_id INTEGER REFERENCES teachers(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
-- Messages for parents (SMS / email). A real deployment would hand these to a
-- gateway; the demo only records them.
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_class ON attendance(class_id, date);
CREATE INDEX IF NOT EXISTS idx_sessions_tt ON sessions(timetable_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_payments_month ON payments(month);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { open };
