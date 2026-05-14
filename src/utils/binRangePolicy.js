/**
 * Range policy helpers for DLMM deploys.
 *
 * Goal:
 * - prefer the highest safe rent-free subrange inside the desired LP window
 * - keep the top edge as close as possible to the active price
 * - only veto when no initialized contiguous bin-array segment can fit
 */

export const BIN_ARRAY_SIZE = 70;

function toBinId(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

export function buildContiguousInitializedRuns(arrayStatuses = []) {
  const sorted = Array.isArray(arrayStatuses)
    ? arrayStatuses
      .filter((item) => item && Number.isFinite(Number(item.idx)))
      .map((item) => ({
        idx: Math.floor(Number(item.idx)),
        initialized: !!item.initialized,
      }))
      .sort((a, b) => a.idx - b.idx)
    : [];

  const runs = [];
  let run = null;

  for (const item of sorted) {
    if (!item.initialized) {
      if (run) {
        runs.push(run);
        run = null;
      }
      continue;
    }

    if (!run) {
      run = { startIdx: item.idx, endIdx: item.idx };
      continue;
    }

    if (item.idx === run.endIdx + 1) {
      run.endIdx = item.idx;
    } else {
      runs.push(run);
      run = { startIdx: item.idx, endIdx: item.idx };
    }
  }

  if (run) runs.push(run);
  return runs;
}

/**
 * Pick the best rent-free subrange from a set of bin-array statuses.
 *
 * Preference order:
 * - highest possible upper edge
 * - widest range inside that upper edge
 * - highest lower edge when ties remain
 */
export function selectRentFreeRange({
  desiredMin,
  desiredMax,
  maxBins = 68,
  arrayStatuses = [],
  binsPerArray = BIN_ARRAY_SIZE,
} = {}) {
  const min = toBinId(desiredMin);
  const max = toBinId(desiredMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null;

  const safeMaxBins = Math.max(2, Math.floor(Number(maxBins) || 0) || 2);
  const runs = buildContiguousInitializedRuns(arrayStatuses);
  if (runs.length === 0) return null;

  let best = null;

  for (const run of runs) {
    const runLower = run.startIdx * binsPerArray;
    const runUpper = (run.endIdx * binsPerArray) + (binsPerArray - 1);

    let rangeMin = Math.max(min, runLower);
    const rangeMax = Math.min(max, runUpper);
    if (rangeMax < rangeMin) continue;

    if ((rangeMax - rangeMin + 1) > safeMaxBins) {
      rangeMin = rangeMax - (safeMaxBins - 1);
    }

    if (rangeMax < rangeMin) continue;

    const candidate = {
      rangeMin,
      rangeMax,
      width: rangeMax - rangeMin + 1,
      runStartIdx: run.startIdx,
      runEndIdx: run.endIdx,
    };

    if (
      !best ||
      candidate.rangeMax > best.rangeMax ||
      (candidate.rangeMax === best.rangeMax && candidate.width > best.width) ||
      (candidate.rangeMax === best.rangeMax && candidate.width === best.width && candidate.rangeMin > best.rangeMin)
    ) {
      best = candidate;
    }
  }

  return best;
}
