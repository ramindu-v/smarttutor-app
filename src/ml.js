// Attendance prediction and batch recommendations.
//
// 1. A logistic-regression model predicts whether a student will attend their
//    next session of a class, from their recent attendance history. It is
//    trained on the centre's own attendance records (older sessions for
//    training, the most recent 20% of dates for testing).
// 2. k-means clustering groups student/class pairs by marks and attendance to
//    recommend an Advanced, Standard or Support batch.

const FEATURES = ['Last 5 sessions attended', 'All sessions attended', 'Late arrivals', 'Weekend class', 'Sessions since last absence'];

const attended = (s) => (s === 'absent' ? 0 : 1);
const rate = (arr, fallback) => (arr.length ? arr.reduce((a, s) => a + attended(s), 0) / arr.length : fallback);

// Features for predicting a student's next session of a class, from the
// statuses of their earlier sessions across all their classes.
function featuresFrom(studentHistory, weekend) {
  const all = rate(studentHistory, 0.85);
  const last5 = rate(studentHistory.slice(-5), all);
  const late = studentHistory.length ? studentHistory.filter((s) => s === 'late').length / studentHistory.length : 0;
  const lastAbsent = studentHistory.lastIndexOf('absent');
  const streak = Math.min(10, lastAbsent === -1 ? 10 : studentHistory.length - 1 - lastAbsent) / 10;
  return [last5, all, late, weekend ? 1 : 0, streak];
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function train(X, y, { epochs = 300, lr = 0.5, l2 = 0.001 } = {}) {
  const d = X[0].length;
  const mean = Array(d).fill(0), std = Array(d).fill(0);
  for (const x of X) x.forEach((v, j) => { mean[j] += v / X.length; });
  for (const x of X) x.forEach((v, j) => { std[j] += (v - mean[j]) ** 2 / X.length; });
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  const Z = X.map((x) => x.map((v, j) => (v - mean[j]) / std[j]));
  let w = Array(d).fill(0), b = 0;
  for (let e = 0; e < epochs; e++) {
    const gw = Array(d).fill(0); let gb = 0;
    for (let i = 0; i < Z.length; i++) {
      const err = sigmoid(Z[i].reduce((s, v, j) => s + v * w[j], b)) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * Z[i][j];
      gb += err;
    }
    w = w.map((wj, j) => wj - lr * (gw[j] / Z.length + l2 * wj));
    b -= lr * gb / Z.length;
  }
  return { w, b, mean, std };
}

const predictOne = (m, x) => sigmoid(x.reduce((s, v, j) => s + ((v - m.mean[j]) / m.std[j]) * m.w[j], m.b));

function auc(scores, labels) {
  const pos = [], neg = [];
  scores.forEach((s, i) => (labels[i] ? pos : neg).push(s));
  if (!pos.length || !neg.length) return null;
  const all = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  all.forEach(([, l], i) => { if (l) rankSum += i + 1; });
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

// Attendance records grouped by student, oldest first.
function loadHistories(db) {
  const rows = db.prepare('SELECT student_id, class_id, date, status FROM attendance ORDER BY student_id, date, class_id').all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.student_id)) map.set(r.student_id, []);
    map.get(r.student_id).push(r);
  }
  return map;
}

const isWeekendDate = (s) => { const d = new Date(s + 'T00:00:00').getDay(); return d === 0 || d === 6; };

// Features for every record of a student, each computed from earlier records only.
function* samples(items) {
  const before = [];
  for (const it of items) {
    if (before.length >= 3) yield { item: it, x: featuresFrom(before, isWeekendDate(it.date)) };
    before.push(it.status);
  }
}

// Features for a student's next session of a class.
function currentFeatures(db, items, classId) {
  const s = db.prepare(`SELECT s.day FROM sessions s JOIN timetables t ON t.id = s.timetable_id AND t.is_active = 1
                         WHERE s.class_id = ? LIMIT 1`).get(classId);
  return featuresFrom((items || []).map((i) => i.status), s ? s.day >= 5 : false);
}

let model = null;
const RISK_THRESHOLD = 0.75;

function trainModel(db) {
  const histories = loadHistories(db);
  const dates = [...new Set([].concat(...[...histories.values()].map((h) => h.map((i) => i.date))))].sort();
  if (dates.length < 4) { model = null; return null; }
  const cutoff = dates[Math.floor(dates.length * 0.8)];
  const trainX = [], trainY = [], testX = [], testY = [];
  for (const items of histories.values()) {
    for (const { item, x } of samples(items)) {
      const yv = attended(item.status);
      if (item.date < cutoff) { trainX.push(x); trainY.push(yv); } else { testX.push(x); testY.push(yv); }
    }
  }
  if (trainX.length < 20) { model = null; return null; }
  const m = train(trainX, trainY);
  const scores = testX.map((x) => predictOne(m, x));
  const correct = scores.filter((s, i) => (s >= 0.5 ? 1 : 0) === testY[i]).length;
  const attendRate = testY.reduce((a, b) => a + b, 0) / (testY.length || 1);
  // Catching absences is what matters: measure at the "at risk" threshold.
  const absentIdx = testY.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
  const caught = absentIdx.filter((i) => scores[i] < RISK_THRESHOLD).length;
  const flagged = scores.filter((s) => s < RISK_THRESHOLD).length;
  m.metrics = {
    trainedAt: new Date().toISOString(),
    trainSamples: trainX.length,
    testSamples: testX.length,
    accuracy: testX.length ? correct / testX.length : null,
    baselineAccuracy: Math.max(attendRate, 1 - attendRate),
    auc: auc(scores, testY),
    riskThreshold: RISK_THRESHOLD,
    absenceRecall: absentIdx.length ? caught / absentIdx.length : null,
    absencePrecision: flagged ? caught / flagged : null,
    weights: FEATURES.map((name, j) => ({ name, weight: m.w[j] })),
  };
  model = m;
  return m.metrics;
}

const metrics = () => (model ? model.metrics : null);

function riskLevel(p) {
  if (p < 0.6) return 'high';
  if (p < RISK_THRESHOLD) return 'medium';
  return 'low';
}

// Prediction for one student across their classes.
function predictStudent(db, studentId, histories) {
  const items = (histories || loadHistories(db)).get(studentId) || [];
  const classes = db.prepare('SELECT c.id, c.subject, c.grade FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = ?').all(studentId);
  const att = (arr) => (arr.length ? arr.filter((i) => i.status !== 'absent').length / arr.length : null);
  const perClass = classes.map((c) => {
    const mine = items.filter((i) => i.class_id === c.id);
    return {
      classId: c.id, subject: c.subject, sessions: mine.length, rate: att(mine),
      probability: model ? predictOne(model, currentFeatures(db, items, c.id)) : null,
    };
  });
  const dates = [...new Set(items.map((i) => i.date))];
  const splitDate = dates[Math.max(0, dates.length - Math.ceil(dates.length / 3))];
  const recent = att(items.filter((i) => i.date >= splitDate));
  const earlier = att(items.filter((i) => i.date < splitDate));
  const probs = perClass.map((c) => c.probability).filter((p) => p !== null);
  const probability = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : null;
  // Declining: recent attendance is clearly lower than before (one-sided
  // two-proportion z-test at 95%), not just a couple of missed classes.
  const n1 = items.filter((i) => i.date < splitDate).length;
  const n2 = items.length - n1;
  let declining = false;
  if (n1 >= 6 && n2 >= 6 && earlier - recent >= 0.15) {
    const pooled = (earlier * n1 + recent * n2) / (n1 + n2);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
    declining = se > 0 && (earlier - recent) / se >= 1.645;
  }
  let risk = probability === null ? 'unknown' : riskLevel(probability);
  if (declining && risk === 'low') risk = 'medium';
  return { studentId, probability, rate: att(items), recentRate: recent, earlierRate: earlier, declining, risk, perClass };
}

function predictAll(db) {
  const hs = loadHistories(db);
  const students = db.prepare("SELECT id, code, name, grade, branch_id FROM students WHERE status = 'active'").all();
  return students.map((s) => ({ ...s, ...predictStudent(db, s.id, hs) }));
}

// Expected turnout for a class's next session.
function predictTurnout(db, classId) {
  const hs = loadHistories(db);
  const enrolled = db.prepare("SELECT s.id FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.class_id = ? AND s.status = 'active'").all(classId);
  if (!model || !enrolled.length) return null;
  const probs = enrolled.map((s) => ({ studentId: s.id, probability: predictOne(model, currentFeatures(db, hs.get(s.id), classId)) }));
  const expected = probs.reduce((a, p) => a + p.probability, 0);
  return { enrolled: enrolled.length, expected: Math.round(expected), rate: expected / enrolled.length, students: probs };
}

// ---- batch recommendations with k-means (k = 3) on [average mark, attendance]
function kmeans(points, k, iterations = 50) {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  let centroids = Array.from({ length: k }, (_, i) => sorted[Math.floor(((i + 0.5) * sorted.length) / k)].slice());
  let labels = [];
  for (let it = 0; it < iterations; it++) {
    labels = points.map((p) => {
      let best = 0, bestD = Infinity;
      centroids.forEach((c, j) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2; if (d < bestD) { bestD = d; best = j; } });
      return best;
    });
    const next = centroids.map((c, j) => {
      const members = points.filter((_, i) => labels[i] === j);
      return members.length ? [0, 1].map((d) => members.reduce((s, p) => s + p[d], 0) / members.length) : c;
    });
    if (next.every((c, j) => c[0] === centroids[j][0] && c[1] === centroids[j][1])) break;
    centroids = next;
  }
  return { centroids, labels };
}

function batchRecommendations(db) {
  const rows = db.prepare(`
    SELECT e.student_id, e.class_id, c.subject,
           (SELECT AVG(score) FROM marks m WHERE m.student_id = e.student_id AND m.class_id = e.class_id) AS mark,
           (SELECT AVG(CASE WHEN status = 'absent' THEN 0.0 ELSE 1.0 END) FROM attendance a
             WHERE a.student_id = e.student_id AND a.class_id = e.class_id) AS att
      FROM enrollments e JOIN classes c ON c.id = e.class_id`).all()
    .filter((r) => r.mark !== null && r.att !== null);
  if (rows.length < 3) return new Map();
  const { centroids, labels } = kmeans(rows.map((r) => [r.mark / 100, r.att]), 3);
  // name clusters by their combined centroid strength
  const order = centroids.map((c, j) => [c[0] * 0.7 + c[1] * 0.3, j]).sort((a, b) => b[0] - a[0]).map(([, j]) => j);
  const names = {}; ['Advanced', 'Standard', 'Support'].forEach((n, i) => { names[order[i]] = n; });
  const out = new Map();
  rows.forEach((r, i) => out.set(`${r.student_id}:${r.class_id}`, { subject: r.subject, mark: Math.round(r.mark), attendance: r.att, batch: names[labels[i]] }));
  return out;
}

module.exports = { FEATURES, RISK_THRESHOLD, featuresFrom, loadHistories, train, predictOne, trainModel, metrics, predictStudent, predictAll, predictTurnout, batchRecommendations, kmeans, riskLevel };

// ---- cached predictions, refreshed after attendance changes
let cache = null;
let retrainTimer = null;

function predictions(db) {
  if (!cache) cache = new Map(predictAll(db).map((p) => [p.id, p]));
  return cache;
}

function invalidate() { cache = null; }

// Retrain shortly after attendance is saved (several saves in a row retrain once).
function retrainSoon(db, delay = 1500) {
  invalidate();
  clearTimeout(retrainTimer);
  retrainTimer = setTimeout(() => { trainModel(db); invalidate(); }, delay);
  if (retrainTimer.unref) retrainTimer.unref();
}

module.exports.predictions = predictions;
module.exports.invalidate = invalidate;
module.exports.retrainSoon = retrainSoon;
