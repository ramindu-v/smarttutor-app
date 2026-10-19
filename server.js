// SmartTutor - Intelligent Tuition Class Scheduler
// Start with: npm start   (first run creates and seeds data/smarttutor.db)
const fs = require('fs');
const path = require('path');
const { open } = require('./src/db');
const { seed } = require('./src/seed');
const { createApp } = require('./src/app');
const ml = require('./src/ml');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'smarttutor.db');

async function main() {
  const fresh = !fs.existsSync(DB_PATH);
  const db = open(DB_PATH);
  if (fresh || !db.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
    console.log('Creating demo data...');
    await seed(db);
  }
  const metrics = ml.trainModel(db);
  if (metrics) console.log(`Attendance model trained: ${(metrics.accuracy * 100).toFixed(1)}% accuracy on ${metrics.testSamples} recent records`);
  const app = createApp(db, { secureCookies: process.env.SECURE_COOKIES === '1' });
  app.listen(PORT, () => {
    console.log(`SmartTutor is running at http://localhost:${PORT}`);
    console.log('Demo logins: admin/admin123  coordinator/coord123  teacher/teacher123  student/student123');
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
