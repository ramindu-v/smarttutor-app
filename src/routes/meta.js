const express = require('express');
const { requireRole } = require('../http');
const config = require('../config');

module.exports = (db) => {
  const r = express.Router();
  r.get('/', requireRole(), (req, res) => {
    res.json({
      branches: db.prepare('SELECT * FROM branches ORDER BY id').all(),
      rooms: db.prepare('SELECT * FROM rooms ORDER BY branch_id, name').all(),
      grades: config.GRADES,
      subjects: config.SUBJECTS,
      subjectsByLevel: { ol: config.OL_SUBJECTS, al: config.AL_SUBJECTS },
      days: config.DAYS,
      dayHours: config.DAY_HOURS,
      lunchHour: config.LUNCH_HOUR,
    });
  });
  return r;
};
