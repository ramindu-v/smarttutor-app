const test = require('node:test');
const assert = require('node:assert');
const ml = require('../src/ml');
const { rng } = require('../src/util');

test('logistic regression learns a simple pattern', () => {
  const r = rng(1);
  const X = [], y = [];
  for (let i = 0; i < 2000; i++) {
    const a = r(), b = r();
    X.push([a, b]);
    y.push(a + 0.2 * b > 0.6 ? 1 : 0);
  }
  const m = ml.train(X, y);
  const correct = X.filter((x, i) => (ml.predictOne(m, x) >= 0.5 ? 1 : 0) === y[i]).length;
  assert.ok(correct / X.length > 0.95, `accuracy ${correct / X.length}`);
});

test('features use only earlier sessions', () => {
  const x = ml.featuresFrom(['present', 'present', 'absent', 'present', 'present'], true);
  assert.strictEqual(x.length, ml.FEATURES.length);
  assert.strictEqual(x[1], 0.8);  // all sessions
  assert.strictEqual(x[3], 1);    // weekend flag
  assert.strictEqual(x[4], 0.2);  // two sessions since the last absence
});

test('k-means separates clear groups', () => {
  const pts = [[0.9, 0.95], [0.92, 0.9], [0.5, 0.6], [0.55, 0.58], [0.2, 0.3], [0.25, 0.2]];
  const { labels } = ml.kmeans(pts, 3);
  assert.strictEqual(labels[0], labels[1]);
  assert.strictEqual(labels[2], labels[3]);
  assert.strictEqual(labels[4], labels[5]);
  assert.strictEqual(new Set(labels).size, 3);
});
