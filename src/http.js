// Small helpers shared by the route modules.
const { HttpError } = require('./util');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please log in'));
    if (roles.length && !roles.includes(req.user.role)) return next(new HttpError(403, 'You do not have access to this'));
    next();
  };
}

const STAFF = ['admin', 'coordinator'];

function int(value, name, { min, max, optional } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw new HttpError(400, `${name} is not valid`);
  }
  return n;
}

function text(value, name, { optional, max = 200 } = {}) {
  const s = value === undefined || value === null ? '' : String(value).trim();
  if (!s && !optional) throw new HttpError(400, `${name} is required`);
  if (s.length > max) throw new HttpError(400, `${name} is too long`);
  return s;
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

function date(value, name) {
  if (!isDate(value)) throw new HttpError(400, `${name} must be a date (YYYY-MM-DD)`);
  return value;
}

function month(value, name) {
  if (!isMonth(value)) throw new HttpError(400, `${name} must be a month (YYYY-MM)`);
  return value;
}

function csv(res, filename, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = rows.length ? Object.keys(rows[0]) : [];
  const body = [header.map(cell).join(','), ...rows.map((r) => header.map((h) => cell(r[h])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

module.exports = { ah, requireRole, STAFF, int, text, date, month, isDate, isMonth, csv, HttpError };
