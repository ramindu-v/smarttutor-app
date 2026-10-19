// Fills a fresh database with realistic demo data for FutureMinds, Kandy:
// 2 branches, 30 teachers, 400 students, a Prolog-generated timetable and
// ten weeks of attendance, marks and fee payments.
const { GRADES, subjectsForGrade, LAB_SUBJECTS } = require('./config');
const timetable = require('./timetable');
const { rng, hashPassword, today, addDays, dayIndex, monthOf, addMonths, isoWeek, nowStamp } = require('./util');

const FIRST = ['Kasun', 'Nimali', 'Ravindu', 'Tharindu', 'Sanduni', 'Dilshan', 'Hiruni', 'Chamath', 'Ishara', 'Pasindu',
  'Sachini', 'Kavindu', 'Dinithi', 'Yasiru', 'Thisara', 'Imesha', 'Lahiru', 'Nethmi', 'Sahan', 'Oshadi', 'Janith', 'Malki',
  'Sithum', 'Tharushi', 'Akila', 'Ruwini', 'Mohamed', 'Fathima', 'Ayesha', 'Arjun', 'Priya', 'Kavya', 'Nuwan', 'Shehani',
  'Vihanga', 'Senuri', 'Gayan', 'Hasini', 'Dulaj', 'Minoli', 'Rashmika', 'Amaya', 'Sandun', 'Nadeesha', 'Ravishan'];
const LAST = ['Silva', 'Perera', 'Fernando', 'Jayasinghe', 'Dissanayake', 'Bandara', 'Rajapaksha', 'Wickramasinghe',
  'Herath', 'Gunawardena', 'Senanayake', 'Kumara', 'Ratnayake', 'Weerasinghe', 'Ekanayake', 'Abeysekara', 'Karunaratne',
  'Rathnayake', 'Wijesinghe', 'Samarasinghe', 'Rizwan', 'Nazeer', 'Sivakumar', 'Thevarajah', 'Mendis'];

const TEACHERS = [
  // Kandy main branch (branch 1)
  ['Mr. Asanka Perera', 'Mathematics'], ['Ms. Dilani Fernando', 'Mathematics'], ['Mr. Ruwan Bandara', 'Mathematics'],
  ['Dr. Chaminda Silva', 'Science,Chemistry'], ['Ms. Nadeeka Herath', 'Science,Biology'], ['Mr. Kelum Rajapaksha', 'Science'],
  ['Mrs. Shiromi Jayasinghe', 'English'], ['Mr. Daniel Mendis', 'English'], ['Ms. Hasara Ekanayake', 'ICT'],
  ['Mr. Supun Wijesinghe', 'ICT'], ['Prof. Lalith Gunawardena', 'Combined Maths'], ['Mr. Pradeep Kumara', 'Physics'],
  ['Mrs. Anoma Ratnayake', 'Chemistry'], ['Dr. Sunethra Weerasinghe', 'Biology'], ['Mr. Nalin Abeysekara', 'Mathematics,ICT'],
  // Peradeniya branch (branch 2)
  ['Mr. Janaka Karunaratne', 'Mathematics'], ['Ms. Iresha Senanayake', 'Mathematics'], ['Mr. Mahesh Rathnayake', 'Science'],
  ['Ms. Thilini Samarasinghe', 'Science,Biology'], ['Mrs. Kumari Dissanayake', 'English'], ['Mr. Roshan Thevarajah', 'English'],
  ['Mr. Farhan Nazeer', 'ICT'], ['Ms. Shalini Sivakumar', 'ICT'], ['Mr. Upul Wickramasinghe', 'Combined Maths'],
  ['Dr. Prasanna Herath', 'Physics'], ['Mrs. Sandya Bandara', 'Chemistry'], ['Ms. Rangi Mendis', 'Biology'],
  ['Mr. Chathura Silva', 'Mathematics,Combined Maths'], ['Ms. Amali Perera', 'Science'], ['Mr. Isuru Fernando', 'English,ICT'],
];

const FIXED_STUDENTS = [ // the five students from the original mock-up
  ['Kasun Silva', 11, ['Mathematics', 'Science', 'ICT']],
  ['Nimali Perera', 13, ['Combined Maths', 'Physics', 'Chemistry']],
  ['Ravindu Fernando', 10, ['English', 'ICT']],
  ['Tharindu Jayasinghe', 12, ['Physics', 'Chemistry', 'Combined Maths']],
  ['Sanduni Dissanayake', 11, ['Science', 'English']],
];

async function seed(db, { students: studentCount = 400, weeks = 10, seedValue = 2025 } = {}) {
  const r = rng(seedValue);
  const now = today();
  const ins = (sql) => db.prepare(sql);

  db.transaction(() => {
    ins('INSERT INTO branches (id, name) VALUES (?, ?)').run(1, 'Main Branch - Kandy');
    ins('INSERT INTO branches (id, name) VALUES (?, ?)').run(2, 'Branch 2 - Peradeniya');
    const room = ins('INSERT INTO rooms (branch_id, name, capacity, is_lab) VALUES (?, ?, ?, ?)');
    [['Room 101', 40, 0], ['Room 102', 35, 0], ['Room 103', 30, 0], ['Room 104', 25, 0], ['Hall A', 60, 0], ['Lab 1', 40, 1]]
      .forEach(([n, c, l]) => room.run(1, n, c, l));
    [['Room 201', 35, 0], ['Room 202', 30, 0], ['Room 203', 25, 0], ['Lab 2', 35, 1]]
      .forEach(([n, c, l]) => room.run(2, n, c, l));

    const teacher = ins('INSERT INTO teachers (name, email, phone, subjects, available_days, max_per_day, branch_id) VALUES (?, ?, ?, ?, ?, 4, ?)');
    TEACHERS.forEach(([name, subjects], i) => {
      const days = [0, 1, 2, 3, 4, 5, 6].filter(() => r.chance(0.72));
      while (days.length < 4) { const d = r.int(0, 6); if (!days.includes(d)) days.push(d); }
      if (!days.includes(5) && !days.includes(6)) days.push(r.chance(0.5) ? 5 : 6);
      const first = name.split(' ')[1].toLowerCase();
      teacher.run(name, `${first}@futureminds.lk`, `+94 7${r.int(0, 8)} ${r.int(100, 999)} ${r.int(1000, 9999)}`,
        subjects, days.sort().join(','), i < 15 ? 1 : 2);
    });

    // one class per subject per grade per branch, taught by the least loaded teacher of that subject
    const teachers = db.prepare('SELECT * FROM teachers').all();
    const load = new Map();
    const klass = ins('INSERT INTO classes (subject, grade, teacher_id, branch_id, monthly_fee, needs_lab, preference) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const branch of [1, 2]) {
      for (const grade of GRADES) {
        for (const subject of subjectsForGrade(grade)) {
          const options = teachers.filter((t) => t.branch_id === branch && t.subjects.split(',').includes(subject))
            .sort((a, b) => (load.get(a.id) || 0) - (load.get(b.id) || 0));
          const t = options[0];
          load.set(t.id, (load.get(t.id) || 0) + 1);
          klass.run(subject, grade, t.id, branch, grade >= 12 ? 3500 : 2500,
            grade >= 12 && LAB_SUBJECTS.includes(subject) ? 1 : 0, grade >= 12 ? 'weekend' : 'weekday');
        }
      }
    }

    // students
    const classes = db.prepare('SELECT * FROM classes').all();
    const student = ins(`INSERT INTO students (code, name, dob, grade, phone, email, parent_name, parent_phone, address, branch_id, status, joined_on)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const enroll = ins('INSERT INTO enrollments (student_id, class_id, enrolled_on) VALUES (?, ?, ?)');
    const towns = ['Kandy', 'Peradeniya', 'Katugastota', 'Gampola', 'Pilimathalawa', 'Digana', 'Kundasale', 'Ampitiya'];
    const used = new Set(FIXED_STUDENTS.map((s) => s[0]));
    for (let i = 0; i < studentCount; i++) {
      let name, grade, subjects;
      if (i < FIXED_STUDENTS.length) [name, grade, subjects] = FIXED_STUDENTS[i];
      else {
        do { name = `${r.pick(FIRST)} ${r.pick(LAST)}`; } while (used.has(name));
        used.add(name);
        grade = r.pick(GRADES);
        const all = subjectsForGrade(grade);
        subjects = all.filter(() => r.chance(0.6));
        if (subjects.length < 2) subjects = all.slice(0, 2);
        if (subjects.length > 4) subjects = subjects.slice(0, 4);
      }
      const branch = i < FIXED_STUDENTS.length ? 1 : (r.chance(0.6) ? 1 : 2);
      const birthYear = new Date().getFullYear() - (grade + 5);
      const dayOfMonth = Number(now.slice(8, 10));
      const joined = i >= FIXED_STUDENTS.length && r.chance(0.05) && dayOfMonth > 1
        ? addDays(now, -r.int(1, dayOfMonth - 1)) // a few new registrations this month
        : addDays(now, -r.int(weeks * 7 + 10, 500));
      const lastName = name.split(' ').slice(-1)[0];
      const status = i >= FIXED_STUDENTS.length && r.chance(0.04) ? 'inactive' : 'active';
      const res = student.run(`ST2025${String(i + 1).padStart(3, '0')}`, name,
        `${birthYear}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`, grade,
        `+94 7${r.int(0, 8)} ${r.int(100, 999)} ${r.int(1000, 9999)}`, `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@mail.lk`,
        `${r.chance(0.5) ? 'Mr.' : 'Mrs.'} ${lastName}`, `+94 7${r.int(0, 8)} ${r.int(100, 999)} ${r.int(1000, 9999)}`,
        `${r.int(1, 220)}, ${r.pick(['Temple', 'Lake', 'Station', 'Hill', 'Main', 'Peradeniya'])} Road, ${r.pick(towns)}`,
        branch, status, joined);
      for (const s of subjects) {
        const c = classes.find((k) => k.branch_id === branch && k.grade === grade && k.subject === s);
        if (c) enroll.run(res.lastInsertRowid, c.id, joined);
      }
    }

    // logins
    const user = ins('INSERT INTO users (username, password_hash, role, name, teacher_id, student_id) VALUES (?, ?, ?, ?, ?, ?)');
    user.run('admin', hashPassword('admin123'), 'admin', 'Administrator', null, null);
    user.run('coordinator', hashPassword('coord123'), 'coordinator', 'Academic Coordinator', null, null);
    const teacherHash = hashPassword('teacher123');
    for (const t of teachers) {
      const username = t.id === 1 ? 'teacher' : t.name.split(' ')[1].toLowerCase() + t.id;
      user.run(username, teacherHash, 'teacher', t.name, t.id, null);
    }
    const studentHash = hashPassword('student123');
    const firstStudents = db.prepare('SELECT * FROM students ORDER BY id LIMIT 5').all();
    firstStudents.forEach((s, i) => user.run(i === 0 ? 'student' : s.code.toLowerCase(), studentHash, 'student', s.name, null, s.id));
  })();

  // timetables from the Prolog solver
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  for (const branch of [1, 2]) {
    const g = await timetable.generate(db, branch, {});
    timetable.saveTimetable(db, branch, {
      week: isoWeek(now), settings: g.problem.settings, score: g.score, assignments: g.result.assignments, userId: adminId,
    });
  }

  db.transaction(() => {
    // attendance history: each student has a habit; some are slipping lately
    const sessions = timetable.activeSessions(db);
    const enrolled = db.prepare(`SELECT e.student_id, e.class_id, s.joined_on FROM enrollments e
                                   JOIN students s ON s.id = e.student_id`).all();
    const byClass = new Map();
    for (const e of enrolled) { if (!byClass.has(e.class_id)) byClass.set(e.class_id, []); byClass.get(e.class_id).push(e); }
    const habit = new Map(), slipping = new Set();
    const studentIds = db.prepare('SELECT id, status FROM students').all();
    const known = { 1: 0.96, 2: 0.94, 3: 0.88, 4: 0.93, 5: 0.92 }; // the five students from the mock-up
    for (const s of studentIds) {
      habit.set(s.id, known[s.id] || (s.status === 'inactive' ? 0.45 : Math.min(0.99, 0.72 + r() * 0.28)));
      if (s.id === 4 || (s.id > 5 && r.chance(0.09))) slipping.add(s.id); // Tharindu is the declining student
    }
    const lastAbsent = new Map();
    const att = db.prepare('INSERT INTO attendance (class_id, student_id, date, status, marked_by) VALUES (?, ?, ?, ?, ?)');
    const teacherUser = new Map(db.prepare('SELECT teacher_id, id FROM users WHERE teacher_id IS NOT NULL').all().map((u) => [u.teacher_id, u.id]));
    const start = addDays(now, -weeks * 7);
    for (let date = start; date < now; date = addDays(date, 1)) {
      const day = dayIndex(date);
      const progress = (Date.parse(date) - Date.parse(start)) / (weeks * 7 * 86400000);
      for (const s of sessions.filter((x) => x.day === day)) {
        for (const e of byClass.get(s.class_id) || []) {
          if (e.joined_on > date) continue;
          let p = habit.get(e.student_id) + (day >= 5 ? 0.03 : 0) - (day === 2 ? 0.05 : 0);
          if (slipping.has(e.student_id) && progress > 0.5) p -= 0.8 * (progress - 0.45);
          if (lastAbsent.get(e.student_id)) p -= 0.18; // absences come in streaks (illness, exams, travel)
          const status = r() < p ? (r.chance(0.07) ? 'late' : 'present') : 'absent';
          lastAbsent.set(e.student_id, status === 'absent');
          att.run(s.class_id, e.student_id, date, status, teacherUser.get(s.teacher_id) || null);
        }
      }
    }

    // marks for two terms, linked to attendance habit
    const mark = db.prepare('INSERT INTO marks (student_id, class_id, term, score) VALUES (?, ?, ?, ?)');
    for (const e of enrolled) {
      const base = 30 + habit.get(e.student_id) * 55;
      for (const term of ['Term 1', 'Term 2']) {
        const drift = term === 'Term 2' && slipping.has(e.student_id) ? -10 : 0;
        mark.run(e.student_id, e.class_id, term, Math.max(5, Math.min(100, Math.round(base + drift + (r() - 0.5) * 30))));
      }
    }

    // fee payments for the last five months and this month
    const fees = db.prepare(`SELECT s.id, s.status, s.joined_on, SUM(c.monthly_fee) AS fee FROM students s
                               JOIN enrollments e ON e.student_id = s.id JOIN classes c ON c.id = e.class_id GROUP BY s.id`).all();
    const pay = db.prepare('INSERT INTO payments (receipt_no, student_id, month, amount, method, paid_on, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const thisMonth = monthOf(now);
    const dayOfMonth = Number(now.slice(8, 10));
    for (let m = -5; m <= 0; m++) {
      const month = addMonths(thisMonth, m);
      let counter = 0;
      for (const f of fees) {
        if (monthOf(f.joined_on) > month) continue;
        const pPay = m === 0 ? Math.min(0.85, 0.25 + dayOfMonth * 0.04) : (f.status === 'inactive' ? 0.5 : 0.94);
        if (!r.chance(pPay)) continue;
        let paid = `${month}-${String(r.int(1, m === 0 ? Math.max(1, dayOfMonth) : 15)).padStart(2, '0')}`;
        if (paid > now) paid = now;
        counter++;
        pay.run(`RC-${month.replace('-', '')}-${String(counter).padStart(5, '0')}`, f.id, month, f.fee,
          r.pick(['cash', 'cash', 'bank transfer', 'card']), paid, adminId);
      }
    }

    // welcome notifications
    const note = db.prepare('INSERT INTO notifications (user_id, type, title, body, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const u of db.prepare('SELECT id, role FROM users').all()) {
      note.run(u.id, 'schedule', 'Timetable published',
        u.role === 'student' ? 'Your weekly class timetable is ready. Open Schedule to see it.' : 'The weekly timetable for both branches was generated by the AI scheduler with no conflicts.',
        nowStamp());
    }
  })();
}

module.exports = { seed };
