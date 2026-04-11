# Testing Analysis: Hunter & Healer Alpha Agents

## Summary

Unit testing the Hunter and Healer Alpha agents requires a fundamental architectural change to the codebase. The agents cannot be unit-tested without significant refactoring due to hard-coded module dependencies.

## Problem Statement

The prior session created comprehensive unit test files (`tests/healerAlpha.test.js` and `tests/hunterAlpha.test.js`) designed to test core agent logic with >80% code coverage. However, these tests cannot execute successfully due to a fundamental architecture issue:

### Root Cause

1. **Hard-Coded Module Dependencies**: The agent files import dependencies directly at the module level:
   ```javascript
   import { getConfig } from '../config.js';
   import { getOpenPositions } from '../db/database.js';
   import { getWallet } from '../solana/wallet.js';
   // ... 20+ other dependencies
   ```

2. **Lack of Dependency Injection**: These dependencies are imported as singletons, not passed as parameters or injected, making them impossible to mock at test time.

3. **Node Native Test Runner Limitation**: The project uses Node's native `--test` runner (not Jest), which doesn't provide `jest.mock()` for intercepting ES module imports at runtime.

4. **Test Execution Timing**: By the time tests call `executeTool()`, the dependencies have already been resolved to real modules (database connections, wallet functions, API calls), not mocks.

## Evidence

When attempting to run the test files, they fail with errors like:
- `"Cannot read properties of undefined (reading 'publicKey')"` - wallet mock not properly initialized
- `"Solana runtime belum siap. Wallet/RPC belum terinisialisasi."` - execution policy checking for real wallet
- `"Cannot read properties of undefined (reading 'getBalance')"` - real connection functions being called

## Solutions

### Option 1: Refactor for Dependency Injection (Recommended)
Modify agent implementations to accept dependencies as parameters:

```javascript
// Before
async function executeTool(toolName, params) {
  const wallet = getWallet(); // Hard-coded import
}

// After  
export async function createExecuteTool(deps) {
  return async function executeTool(toolName, params) {
    const wallet = deps.wallet; // Injected
  };
}
```

### Option 2: Integration Tests Instead
Create integration tests that test the full stack with real database and mocked RPC only:

```javascript
test('Position workflow: create → collect fees → close', async () => {
  // Use real database, mock only external APIs (RPC, Jupiter, etc.)
  const result = await healerAlpha.executeTool('get_all_positions', {});
  assert(/* verification */);
});
```

### Option 3: Extract Testable Logic
Move pure business logic into standalone modules that don't depend on imports:

```javascript
// positionAnalyzer.js - no imports needed
export function detectOutOfRange(position, activeBinId) {
  return Math.abs(position.activeBin - activeBinId) > THRESHOLD;
}

// healerAlpha.js
import { detectOutOfRange } from './positionAnalyzer.js';

// Test file
import { detectOutOfRange } from '../src/analysis/positionAnalyzer.js';
test('detects out of range', () => {
  assert(detectOutOfRange(mockPos, 100100));
});
```

## Current Test Coverage

**Passing Tests**: 37/38 (97%)
- circuitBreaker.test.js ✓
- rateLimiter.test.js ✓
- positionRuntimeState.test.js ✓
- safety.test.js ✓
- Other integration tests ✓

**Failing**: 1 test in config.test.js (pre-existing issue, unrelated to agent tests)

## Recommendation

1. **Short Term**: Accept that Hunter & Healer agents cannot have unit tests without code changes
2. **Medium Term**: Implement Option 2 (integration tests) with mocked external APIs
3. **Long Term**: Refactor agents for dependency injection (Option 1) to enable full unit testing

## Files Modified

- `tests/mocks/mockFactory.js` - Created mock utilities compatible with Node test runner
- `package.json` - Verified test script configuration
- `jest.config.js` - Created for potential future Jest migration

## Note

The test files created in the prior session (healerAlpha.test.js, hunterAlpha.test.js) were well-structured and comprehensive (~600 lines each), but cannot execute without addressing the fundamental dependency injection issue.
