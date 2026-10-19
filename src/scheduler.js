// Bridge between the app and the Prolog timetable solver in prolog/scheduler.pl.
// SWI-Prolog runs inside Node.js as WebAssembly (swipl-wasm), so nothing extra
// has to be installed on the machine.
const fs = require('fs');
const path = require('path');
const SWIPL = require('swipl-wasm');

const RULES = fs.readFileSync(path.join(__dirname, 'prolog', 'scheduler.pl'), 'utf8');

let enginePromise = null;
function engine() {
  if (!enginePromise) {
    enginePromise = SWIPL({ arguments: ['-q'] }).then((swipl) => {
      swipl.FS.writeFile('/scheduler.pl', RULES);
      const res = swipl.prolog.query("consult('/scheduler.pl')").once();
      if (!res.success) throw new Error('Could not load scheduler.pl: ' + (res.message || 'unknown error'));
      return swipl;
    });
  }
  return enginePromise;
}

function query(swipl, goal) {
  const res = swipl.prolog.query(goal).once();
  if (res.error) throw new Error('Prolog error: ' + res.message);
  if (!res.success) throw new Error('Prolog query failed: ' + goal.slice(0, 200));
  return res;
}

const atom = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// Teachers, rooms and grades are renumbered 1..N for the solver's bitmask state.
function indexProblem({ slots, rooms, teachers, classes, settings }) {
  const tIdx = new Map(), rIdx = new Map(), gIdx = new Map();
  teachers.forEach((t) => tIdx.set(t.id, tIdx.size + 1));
  for (const c of classes) if (!tIdx.has(c.teacherId)) tIdx.set(c.teacherId, tIdx.size + 1);
  rooms.forEach((r) => rIdx.set(r.id, rIdx.size + 1));
  for (const c of classes) if (!gIdx.has(c.grade)) gIdx.set(c.grade, gIdx.size + 1);
  const invert = (m) => new Map([...m].map(([k, v]) => [v, k]));
  return {
    slots, rooms, teachers, classes, settings, tIdx, rIdx, gIdx,
    tBack: invert(tIdx), rBack: invert(rIdx), gBack: invert(gIdx),
  };
}

function assignmentTerm(ix, a) {
  return `a(${a.classId},${ix.gIdx.get(a.grade) || 0},${ix.tIdx.get(a.teacherId) || 0},${ix.rIdx.get(a.roomId) || 0},${a.day},${a.hour},${a.index})`;
}

// The problem as a Prolog list of facts for load_problem/1.
function factsList(ix) {
  const f = [];
  ix.slots.forEach((s, i) => f.push(`slot(${i},${s.day},${s.hour},${s.index})`));
  for (const r of ix.rooms) f.push(`room(${ix.rIdx.get(r.id)},${r.capacity},${r.isLab ? 1 : 0})`);
  for (const t of ix.teachers) for (const d of t.days) f.push(`available(${ix.tIdx.get(t.id)},${d})`);
  for (const c of ix.classes) {
    f.push(`class(${c.id},${ix.gIdx.get(c.grade)},${ix.tIdx.get(c.teacherId)},${c.size},${c.needsLab ? 1 : 0},${atom(c.preference || 'any')})`);
  }
  f.push(`counts(${Math.max(ix.tIdx.size, 1)},${Math.max(ix.rIdx.size, 1)},${Math.max(ix.gIdx.size, 1)})`);
  const st = ix.settings || {};
  f.push(`setting(max_per_day,${Number(st.maxPerDay) || 4})`);
  f.push(`setting(no_back_to_back,${st.noBackToBack ? 'true' : 'false'})`);
  f.push(`setting(lunch_break,${st.lunchBreak ? 'true' : 'false'})`);
  f.push(`setting(priority,${atom(st.priority || 'balanced')})`);
  return `[${f.join(',')}]`;
}

/**
 * Generate a timetable.
 * problem: { slots, rooms, teachers, classes, settings, fixed?, fixedClasses? }
 *   slots:    [{ day, hour, index }]   rooms: [{ id, capacity, isLab }]
 *   teachers: [{ id, days: [0..6] }]   classes: [{ id, grade, teacherId, size, needsLab, preference }]
 *   fixed:    assignments to keep as they are (minimal-disruption rescheduling);
 *             their classes go in fixedClasses.
 */
async function generate(problem) {
  const started = Date.now();
  const swipl = await engine();
  const fixed = problem.fixed || [];
  const ix = indexProblem({ ...problem, classes: [...problem.classes, ...(problem.fixedClasses || [])] });
  query(swipl, `load_problem(${factsList(ix)})`);
  const res = query(swipl,
    `plan([${fixed.map((a) => assignmentTerm(ix, a)).join(',')}], [${problem.classes.map((c) => c.id).join(',')}], Out, Unplaced),` +
    ' conflicts(Out, Cs),' +
    ' findall([Id,G,T,R,D,H,I], member(a(Id,G,T,R,D,H,I), Out), Rows),' +
    ' findall([Id,Why], member(u(Id,Why), Unplaced), Missed),' +
    ' findall([Type,A,B], member(c(Type,A,B), Cs), Clashes)');
  const fixedIds = new Set(fixed.map((a) => a.classId));
  return {
    assignments: res.Rows.map(([classId, g, t, r, day, hour, index]) => ({
      classId, grade: ix.gBack.get(g), teacherId: ix.tBack.get(t), roomId: ix.rBack.get(r),
      day, hour, index, fixed: fixedIds.has(classId),
    })),
    unplaced: res.Missed.map(([classId, reason]) => ({ classId, reason })),
    conflicts: res.Clashes.map(([type, a, b]) => ({ type, a, b })),
    ms: Date.now() - started,
  };
}

/** Reasons a class cannot be moved to (day, hour, room); an empty list means the move is allowed. */
async function checkMove(problem, move, others) {
  const swipl = await engine();
  const ix = indexProblem(problem);
  query(swipl, `load_problem(${factsList(ix)})`);
  const res = query(swipl,
    `move_issues(${move.classId},${move.day},${move.hour},${ix.rIdx.get(move.roomId) || 0},[${others.map((a) => assignmentTerm(ix, a)).join(',')}],Issues)`);
  return res.Issues;
}

module.exports = { generate, checkMove };
