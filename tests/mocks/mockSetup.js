/**
 * Mock setup for all external dependencies
 * Centralizes all jest.mock() calls and test fixtures
 */

import {
  MOCK_POOLS,
  MOCK_POSITIONS,
  MOCK_MARKET_DATA,
  MOCK_CONFIG,
  MOCK_WALLET,
  MOCK_THRESHOLDS,
} from './mockData.js';

/**
 * Setup all mocks before tests run
 */
export function setupMocks() {
  // Mock @solana/web3.js
  global.mockConnection = {
    getAccountInfo: jest.fn().mockResolvedValue({ lamports: 2000000 }),
    getSignatureStatus: jest.fn().mockResolvedValue({
      value: { confirmationStatus: 'finalized' },
    }),
    getLatestBlockhash: jest.fn().mockResolvedValue({
      blockhash: 'MockBlockHash123456789',
      lastValidBlockHeight: 300000,
    }),
  };

  global.mockWallet = {
    publicKey: { toString: () => MOCK_WALLET.address },
    secretKey: new Uint8Array(64).fill(1),
  };

  global.mockDLMM = {
    create: jest.fn(),
    getLbPair: jest.fn(),
    getActiveBin: jest.fn(),
  };

  // Mock Meteora SDK
  jest.mock('@meteora-ag/dlmm', () => ({
    default: {
      create: jest.fn().mockResolvedValue({
        tokenX: { publicKey: { toString: () => MOCK_POOLS.valid_stable.tokenX } },
        tokenY: { publicKey: { toString: () => MOCK_POOLS.valid_stable.tokenY } },
        lbPair: { binStep: MOCK_POOLS.valid_stable.binStep },
        getActiveBin: jest.fn().mockResolvedValue({
          binId: MOCK_POOLS.valid_stable.activeBinId,
          price: MOCK_POOLS.valid_stable.activeBinPrice,
        }),
        openPosition: jest.fn().mockResolvedValue({
          transactionSignature: 'MockTxSig123456',
          position: {
            address: MOCK_POSITIONS.open_profitable.position_address,
            positionBump: 255,
          },
        }),
        closePosition: jest.fn().mockResolvedValue({
          transactionSignature: 'MockCloseTx123456',
        }),
        claimAllFees: jest.fn().mockResolvedValue({
          transactionSignature: 'MockFeeTx123456',
          xFeeAmount: 100000000,
          yFeeAmount: 0,
        }),
      }),
    },
    chunkBinRange: jest.fn((minBin, maxBin, chunkSize) => {
      const chunks = [];
      for (let i = minBin; i < maxBin; i += chunkSize) {
        chunks.push({
          minBinId: i,
          maxBinId: Math.min(i + chunkSize - 1, maxBin),
        });
      }
      return chunks;
    }),
  }), { virtual: true });

  // Mock database functions
  jest.mock('../src/db/database.js', () => ({
    getOpenPositions: jest.fn().mockReturnValue([MOCK_POSITIONS.open_profitable]),
    getClosedPositions: jest.fn().mockReturnValue([]),
    getPoolStats: jest.fn((poolAddress) => {
      if (poolAddress === MOCK_POOLS.valid_stable.address) {
        return { winRate: 72, totalTrades: 18, avgPnl: 2.5 };
      }
      return null;
    }),
    savePosition: jest.fn().mockResolvedValue(true),
    closePositionWithPnl: jest.fn().mockResolvedValue(true),
    updatePositionLifecycle: jest.fn().mockReturnValue(true),
    createOperationLog: jest.fn().mockReturnValue({ lastInsertRowid: 1 }),
    updateOperationLog: jest.fn().mockReturnValue(true),
  }), { virtual: true });

  // Mock config functions
  jest.mock('../src/config.js', () => ({
    getConfig: jest.fn().mockReturnValue(MOCK_CONFIG),
    getThresholds: jest.fn().mockReturnValue(MOCK_THRESHOLDS),
    updateConfig: jest.fn().mockReturnValue(true),
    isDryRun: jest.fn().mockReturnValue(false),
  }), { virtual: true });

  // Mock solana wallet functions
  jest.mock('../src/solana/wallet.js', () => ({
    getConnection: jest.fn().mockReturnValue(global.mockConnection),
    getWallet: jest.fn().mockReturnValue(global.mockWallet),
    getWalletBalance: jest.fn().mockResolvedValue('2.5'),
  }), { virtual: true });

  // Mock market data functions
  jest.mock('../src/market/oracle.js', () => ({
    getMarketSnapshot: jest.fn().mockResolvedValue({
      pool: {
        feeApr: 10.5,
        feeAprCategory: 'MEDIUM',
        feeTvlRatio: 0.03,
        tvl: 150000,
        volume24h: 500000,
      },
      price: MOCK_MARKET_DATA.stable_trend,
      healthScore: 95,
    }),
    getOHLCV: jest.fn().mockResolvedValue(MOCK_MARKET_DATA.stable_trend),
    fetchCandles: jest.fn().mockResolvedValue([]),
  }), { virtual: true });

  // Mock pool functions
  jest.mock('../src/solana/meteora.js', () => ({
    getPoolInfo: jest.fn().mockResolvedValue({
      address: MOCK_POOLS.valid_stable.address,
      tokenX: MOCK_POOLS.valid_stable.tokenX,
      tokenY: MOCK_POOLS.valid_stable.tokenY,
      tokenXSymbol: MOCK_POOLS.valid_stable.tokenXSymbol,
      tokenYSymbol: MOCK_POOLS.valid_stable.tokenYSymbol,
      binStep: MOCK_POOLS.valid_stable.binStep,
      tvl: MOCK_POOLS.valid_stable.tvl,
    }),
    openPosition: jest.fn().mockResolvedValue({
      txHash: 'MockTxHash123456',
      positionAddress: MOCK_POSITIONS.open_profitable.position_address,
    }),
    closePositionDLMM: jest.fn().mockResolvedValue({
      txHash: 'MockCloseTxHash123456',
    }),
    claimFees: jest.fn().mockResolvedValue({
      txHash: 'MockFeesTxHash123456',
      feesX: 0.1,
      feesY: 0,
    }),
    getTopPools: jest.fn().mockResolvedValue([MOCK_POOLS.valid_stable]),
  }), { virtual: true });

  // Mock safety functions
  jest.mock('../src/safety/safetyManager.js', () => ({
    checkStopLoss: jest.fn().mockReturnValue({ triggered: false }),
    checkMaxDrawdown: jest.fn().mockReturnValue({ triggered: false }),
    validateStrategyForMarket: jest.fn().mockReturnValue({ ok: true }),
    requestConfirmation: jest.fn().mockResolvedValue(true),
  }), { virtual: true });

  // Mock strategy functions
  jest.mock('../src/strategies/profiles.js', () => ({
    getStrategyProfile: jest.fn((name) => {
      if (name === 'Evil Panda') {
        return {
          allowedBinSteps: [1, 5, 10, 20, 50, 100],
          entry: { momentumTriggerM5: 1.5 },
          deploy: { fixedBinsBelow: 68, label: 'Spot' },
        };
      }
      return null;
    }),
  }), { virtual: true });

  // Mock market analysis
  jest.mock('../src/market/strategyLibrary.js', () => ({
    matchStrategyToMarket: jest.fn().mockReturnValue({
      recommended: { name: 'Evil Panda', matchScore: 0.85 },
    }),
  }), { virtual: true });

  // Mock learning/evolution
  jest.mock('../src/learn/evolve.js', () => ({
    runEvolutionCycle: jest.fn().mockResolvedValue(null),
  }), { virtual: true });

  // Mock utilities
  jest.mock('../src/utils/safeJson.js', () => ({
    withRetry: jest.fn((fn) => fn()),
    withExponentialBackoff: jest.fn((fn) => fn()),
    fetchWithTimeout: jest.fn(),
  }), { virtual: true });
}

/**
 * Reset all mocks before each test
 */
export function resetMocks() {
  jest.clearAllMocks();
}

/**
 * Create a mock pool with custom data
 */
export function createMockPool(overrides = {}) {
  return {
    ...MOCK_POOLS.valid_stable,
    ...overrides,
  };
}

/**
 * Create a mock position with custom data
 */
export function createMockPosition(overrides = {}) {
  return {
    ...MOCK_POSITIONS.open_profitable,
    ...overrides,
  };
}

/**
 * Create a mock market snapshot
 */
export function createMockMarketSnapshot(overrides = {}) {
  return {
    ...MOCK_MARKET_DATA.stable_trend,
    ...overrides,
  };
}
