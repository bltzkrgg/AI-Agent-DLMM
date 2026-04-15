'use strict';

/**
 * A simple async retry wrapper with exponential backoff.
 * 
 * @param {Function} fn - The async function to retry.
 * @param {Object} options - Retry options.
 * @param {number} options.maxRetries - Maximum number of retries (default 3).
 * @param {number} options.delayMs - Initial delay in ms (default 2000).
 * @param {string} options.taskName - Human readable name for logs.
 * @param {Function} options.onRetry - Optional callback called on each retry attempt.
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    delayMs = 2000,
    taskName = 'Async Task',
    onRetry = null,
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const backoff = delayMs * Math.pow(2, attempt - 1);
        console.log(`[retry] ${taskName}: Attempt ${attempt + 1}/${maxRetries + 1} after ${backoff}ms...`);
        if (onRetry) onRetry(attempt, lastError);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(`[retry] ${taskName} (attempt ${attempt + 1}) failed: ${err.message}`);
      
      // Don't retry if it's a specific "user error" or "insufficient funds" type error if possible
      const fatalErrors = ['insufficient funds', 'not enough sol', 'unauthorized'];
      if (fatalErrors.some(msg => err.message.toLowerCase().includes(msg))) {
        throw err;
      }
    }
  }

  throw lastError;
}
