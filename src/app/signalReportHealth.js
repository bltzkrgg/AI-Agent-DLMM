import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getSignalReportHealth({
  reportPath = join(__dirname, '../../data/signal-accuracy-report.json'),
  maxAgeHours = 24,
} = {}) {
  try {
    if (!existsSync(reportPath)) {
      return {
        available: false,
        passed: false,
        ageHours: null,
        stale: true,
        reportPath,
        generatedAt: null,
        summary: null,
        error: null,
      };
    }

    const parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
    const generatedAt = parsed?.generatedAt || null;
    const ts = generatedAt ? Date.parse(generatedAt) : NaN;
    const ageHours = Number.isFinite(ts)
      ? Number(((Date.now() - ts) / (1000 * 60 * 60)).toFixed(2))
      : null;
    const stale = !Number.isFinite(ageHours) || ageHours > Math.max(1, Number(maxAgeHours || 24));

    return {
      available: true,
      passed: parsed?.passed === true,
      ageHours,
      stale,
      reportPath,
      generatedAt,
      summary: parsed?.aggregate || null,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      passed: false,
      ageHours: null,
      stale: true,
      reportPath,
      generatedAt: null,
      summary: null,
      error: error?.message || 'signal report parse failed',
    };
  }
}
