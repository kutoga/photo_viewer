'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreBounds } = require('../lib/window-state.cjs');
const { monthlyCounts } = require('../renderer/model.js');

test('saved windows are restored inside an available display after a monitor is removed', () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(
    restoreBounds({ bounds: { x: 2200, y: 100, width: 1000, height: 800 } }, displays),
    { x: 920, y: 100, width: 1000, height: 800 },
  );
  assert.deepEqual(
    restoreBounds({ bounds: { x: 10, y: 20, width: 1100, height: 700 } }, displays),
    { x: 10, y: 20, width: 1100, height: 700 },
  );
  assert.deepEqual(restoreBounds({ bounds: { width: 'oops' } }, displays), {
    width: 1440,
    height: 960,
  });
});

test('monthly photo counts include gaps and ignore missing or invalid dates', () => {
  assert.deepEqual(
    monthlyCounts([
      { date: '2024-12-12T12:00:00' },
      { date: '2024-12-30T12:00:00' },
      { date: '2025-02-01T12:00:00' },
      { date: null },
      { date: 'invalid' },
    ]),
    [
      { month: '2024-12', count: 2 },
      { month: '2025-01', count: 0 },
      { month: '2025-02', count: 1 },
    ],
  );
});
