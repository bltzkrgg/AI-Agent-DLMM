import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContiguousInitializedRuns, selectRentFreeRange } from '../src/utils/binRangePolicy.js';

test('bin range policy groups contiguous initialized arrays', () => {
  const runs = buildContiguousInitializedRuns([
    { idx: 1, initialized: true },
    { idx: 2, initialized: true },
    { idx: 3, initialized: false },
    { idx: 4, initialized: true },
    { idx: 5, initialized: true },
    { idx: 6, initialized: true },
  ]);

  assert.deepEqual(runs, [
    { startIdx: 1, endIdx: 2 },
    { startIdx: 4, endIdx: 6 },
  ]);
});

test('bin range policy prefers the highest safe contiguous initialized run', () => {
  const chosen = selectRentFreeRange({
    desiredMin: 70,
    desiredMax: 279,
    maxBins: 68,
    arrayStatuses: [
      { idx: 1, initialized: true },
      { idx: 2, initialized: false },
      { idx: 3, initialized: true },
      { idx: 4, initialized: true },
    ],
  });

  assert.ok(chosen);
  assert.equal(chosen.rangeMax, 279);
  assert.equal(chosen.rangeMin, 212);
  assert.equal(chosen.width, 68);
});

test('bin range policy returns null when no initialized run exists', () => {
  const chosen = selectRentFreeRange({
    desiredMin: 0,
    desiredMax: 69,
    maxBins: 68,
    arrayStatuses: [
      { idx: 0, initialized: false },
      { idx: 1, initialized: false },
    ],
  });

  assert.equal(chosen, null);
});
