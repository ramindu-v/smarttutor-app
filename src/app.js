const path = require('path');
const express = require('express');
const auth = require('./auth');
const { HttpError } = require('./util');

function createApp(db, { secureCookies = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(auth.middleware(db));

  app.use('/api/auth', require('./routes/auth')(db, { secureCookies }));
  app.use('/api/meta', require('./routes/meta')(db));
  app.use('/api/dashboard', require('./routes/reports').dashboard(db));
  app.use('/api/students', require('./routes/students')(db));
  app.use('/api/teachers', require('./routes/teachers')(db));
  app.use('/api/classes', require('./routes/teachers').classes(db));
  app.use('/api/schedule', require('./routes/schedule')(db));
  app.use('/api/attendance', require('./routes/attendance')(db));
  app.use('/api/payments', require('./routes/payments')(db));
  app.use('/api/reports', require('./routes/reports')(db));
  app.use('/api/notifications', require('./routes/notifications')(db));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));

  // front-end libraries are served from node_modules, so the app also works offline
  const vendor = (url, dir) => app.use(url, express.static(path.join(__dirname, '..', 'node_modules', dir), { maxAge: '7d' }));
  vendor('/vendor/bootstrap', 'bootstrap/dist');
  vendor('/vendor/fontawesome', '@fortawesome/fontawesome-free');
  vendor('/vendor/chart.js', 'chart.js/dist');
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message });
  });
  return app;
}

module.exports = { createApp };
