import { execFileSync } from 'node:child_process';

export function getWorktreeHealth(cwd = process.cwd()) {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines = output
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    return {
      available: true,
      clean: lines.length === 0,
      dirtyCount: lines.length,
      sample: lines.slice(0, 5),
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      clean: true,
      dirtyCount: 0,
      sample: [],
      error: error?.message || 'git status unavailable',
    };
  }
}

