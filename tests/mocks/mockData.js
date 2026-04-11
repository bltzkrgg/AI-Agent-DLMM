/**
 * High-fidelity mock data for Hunter & Healer agent tests
 * Purpose: Simulate real DLMM pools, positions, and market conditions
 */

export const MOCK_POOLS = {
  valid_stable: {
    address: 'LBUcU6ze2ySxDKcNfohAMeKLmSGbWxD6yucUaLJybLe',
    name: 'USDC-SOL',
    tokenX: 'EPjFWdd5Au57K45EZkeeGmeW527G26S43G7xEoo2e5B', // USDC
    tokenY: 'So11111111111111111111111111111111111111112', // SOL
    tokenXSymbol: 'USDC',
    tokenYSymbol: 'SOL',
    binStep: 10,
    tvl: 150000,
    tvlStr: '$150,000',
    fees24hRaw: 4500, // 3% fee ratio = 4500 / 150000
    volume24hRaw: 500000,
    activeBinId: 100000,
    minBinId: 99900,
    maxBinId: 100100,
    activeBinPrice: 0.0057,
    feeApr: 10.5,
    feeAprCategory: 'MEDIUM',
    feeTvlRatio: 0.03, // 3% per day
  },

  high_volatility: {
    address: 'ABC123DEF456GHI789JKL012MNO345PQR678STU9',
    name: 'PUMP-SOL',
    tokenX: 'PumpXYZ123456789ABCDEFGHIJKLMNOPQRSTUVWX',
    tokenY: 'So11111111111111111111111111111111111111112',
    tokenXSymbol: 'PUMP',
    tokenYSymbol: 'SOL',
    binStep: 150, // High volatility = larger bin step
    tvl: 35000,
    tvlStr: '$35,000',
    fees24hRaw: 2100, // 6% fee ratio
    volume24hRaw: 350000,
    activeBinId: 50000,
    minBinId: 49800,
    maxBinId: 50200,
    activeBinPrice: 0.000001,
    feeApr: 22.0,
    feeAprCategory: 'HIGH',
    feeTvlRatio: 0.06,
  },

  low_volume: {
    address: 'XYZ789ABC456DEF123GHI789JKL012MNO345PQR',
    name: 'SHITCOIN-SOL',
    tokenX: 'ShitMintAddress123456789ABCDEFGHIJKLMNO',
    tokenY: 'So11111111111111111111111111111111111111112',
    tokenXSymbol: 'SHIT',
    tokenYSymbol: 'SOL',
    binStep: 100,
    tvl: 8000,
    tvlStr: '$8,000',
    fees24hRaw: 80, // 1% fee ratio
    volume24hRaw: 15000, // Too low
    activeBinId: 75000,
    minBinId: 74950,
    maxBinId: 75050,
    activeBinPrice: 0.0001,
    feeApr: 4.6,
    feeAprCategory: 'LOW',
    feeTvlRatio: 0.01,
  },

  wsol_only: {
    address: 'NotTokenSOL123456789ABCDEFGHIJKLMNOPQRS',
    name: 'WSOL-USDC',
    tokenX: 'So11111111111111111111111111111111111111112', // SOL
    tokenY: 'EPjFWdd5Au57K45EZkeeGmeW527G26S43G7xEoo2e5B', // USDC (not SOL)
    tokenXSymbol: 'SOL',
    tokenYSymbol: 'USDC',
    binStep: 20,
    tvl: 200000,
    tvlStr: '$200,000',
    fees24hRaw: 6000,
    volume24hRaw: 800000,
    activeBinId: 0,
    minBinId: -50,
    maxBinId: 50,
    activeBinPrice: 175.5,
    feeApr: 11.0,
    feeAprCategory: 'MEDIUM',
    feeTvlRatio: 0.03,
  },
};

export const MOCK_POSITIONS = {
  open_profitable: {
    position_address: 'PosMint1A2B3C4D5E6F7G8H9I0J1K2L3M4N5O6P',
    pool_address: MOCK_POOLS.valid_stable.address,
    pool_name: 'USDC-SOL',
    strategy_used: 'Evil Panda',
    deployed_sol: 0.5,
    deployed_usd: 75,
    lower_bin: 99900,
    upper_bin: 100100,
    active_bin: 100050,
    in_range: true,
    current_value_sol: 0.525, // +5% unrealized
    unclaimed_fees_x: 0.05,
    unclaimed_fees_y: 0,
    pnl_pct: 5.0,
    pnl_sol: 0.025,
    pnl_usd: 3.75,
    status: 'open',
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    age_minutes: 120,
  },

  open_loss: {
    position_address: 'PosMint2X3Y4Z5A6B7C8D9E0F1G2H3I4J5K6L7',
    pool_address: MOCK_POOLS.high_volatility.address,
    pool_name: 'PUMP-SOL',
    strategy_used: 'Evil Panda',
    deployed_sol: 0.3,
    deployed_usd: 45,
    lower_bin: 49800,
    upper_bin: 50200,
    active_bin: 50500, // OUT OF RANGE
    in_range: false,
    current_value_sol: 0.27, // -10% loss
    unclaimed_fees_x: 0.01,
    unclaimed_fees_y: 0,
    pnl_pct: -10.0,
    pnl_sol: -0.03,
    pnl_usd: -4.5,
    status: 'open',
    created_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 2 days ago
    age_minutes: 2880,
  },

  open_with_unclaimed_fees: {
    position_address: 'PosMint3M4N5O6P7Q8R9S0T1U2V3W4X5Y6Z7A8B',
    pool_address: MOCK_POOLS.valid_stable.address,
    pool_name: 'USDC-SOL',
    strategy_used: 'Wave Enjoyer',
    deployed_sol: 1.0,
    deployed_usd: 150,
    lower_bin: 99950,
    upper_bin: 100050,
    active_bin: 100000,
    in_range: true,
    current_value_sol: 0.99, // -1% unrealized
    unclaimed_fees_x: 0.2,
    unclaimed_fees_y: 0.0001, // 0.01 SOL equivalent
    pnl_pct: -1.0,
    pnl_sol: -0.01,
    pnl_usd: -1.5,
    fee_usd: 30, // High unclaimed fees
    status: 'open',
    created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // 1 week ago
    age_minutes: 10080,
  },
};

export const MOCK_MARKET_DATA = {
  stable_trend: {
    tokenX: MOCK_POOLS.valid_stable.tokenX,
    poolAddress: MOCK_POOLS.valid_stable.address,
    priceChangeM5: 0.5, // +0.5% in 5 min
    priceChangeH1: 1.2, // +1.2% in 1 hour
    range24hPct: 2.5, // 2.5% volatility
    trend: 'UPTREND',
    volatilityCategory: 'LOW',
    sentiment: 'bullish',
    buyPressurePct: 65,
  },

  volatile_trend: {
    tokenX: MOCK_POOLS.high_volatility.tokenX,
    poolAddress: MOCK_POOLS.high_volatility.address,
    priceChangeM5: 8.5, // +8.5% in 5 min (high volatility)
    priceChangeH1: -2.0, // -2% in 1 hour (conflicting signal)
    range24hPct: 45.0, // 45% volatility
    trend: 'CHOPPY',
    volatilityCategory: 'EXTREME',
    sentiment: 'uncertain',
    buyPressurePct: 40,
  },

  downtrend: {
    tokenX: MOCK_POOLS.low_volume.tokenX,
    poolAddress: MOCK_POOLS.low_volume.address,
    priceChangeM5: -1.5,
    priceChangeH1: -5.0,
    range24hPct: 8.0,
    trend: 'DOWNTREND',
    volatilityCategory: 'MEDIUM',
    sentiment: 'bearish',
    buyPressurePct: 25,
  },
};

export const MOCK_CONFIG = {
  deployAmountSol: 0.1,
  maxPositions: 10,
  minSolToOpen: 0.07,
  gasReserve: 0.02,
  managementIntervalMin: 15,
  screeningIntervalMin: 15,
  dryRun: false,

  // Screening thresholds
  minFeeActiveTvlRatio: 0.05,
  minTvl: 10000,
  maxTvl: 150000,
  minOrganic: 55,
  minBinStep: 1,
  minTokenFeesSol: 0,
  minMcap: 250000,
  minVolume24h: 1000000,

  // Safety
  stopLossPct: 5,
  maxDailyDrawdownPct: 10,
  requireConfirmation: false,

  // Darwinian
  autonomousEvolutionEnabled: true,
  signalWeights: {
    mcap: 2.5,
    feeActiveTvlRatio: 2.3,
    volume: 0.36,
    holderCount: 0.3,
  },
};

export const MOCK_WALLET = {
  address: 'WalletAddress123456789ABCDEFGHIJKLMNOPQR',
  balanceSol: 2.5,
  balanceUsd: 375,
};

export const MOCK_THRESHOLDS = {
  minTvl: 10000,
  maxTvl: 150000,
  minFeeActiveTvlRatio: 0.05,
  minOrganic: 55,
};

/**
 * Scenarios for testing
 */
export const TEST_SCENARIOS = {
  happy_path_screening: {
    description: 'Screen pools → find valid stable pool → ready to deploy',
    expectedPools: [MOCK_POOLS.valid_stable],
    expectedBadPools: [MOCK_POOLS.low_volume, MOCK_POOLS.wsol_only],
  },

  happy_path_deployment: {
    description: 'Deploy to valid stable pool with correct parameters',
    poolInput: MOCK_POOLS.valid_stable.address,
    expectedSuccess: true,
    expectedStrategy: 'Evil Panda',
  },

  reject_non_wsol_pool: {
    description: 'Reject deployment to pool where tokenY is not SOL',
    poolInput: MOCK_POOLS.wsol_only.address,
    expectedSuccess: false,
    expectedReason: 'not WSOL',
  },

  position_close_profitable: {
    description: 'Close profitable position → record PnL correctly',
    positionInput: MOCK_POSITIONS.open_profitable,
    expectedPnlPositive: true,
    expectedFeesClaimed: false,
  },

  position_close_with_fees: {
    description: 'Close position with unclaimed fees → auto-claim before close',
    positionInput: MOCK_POSITIONS.open_with_unclaimed_fees,
    expectedFeesClaimed: true,
  },

  position_oor_close: {
    description: 'Close out-of-range position → trigger exit',
    positionInput: MOCK_POSITIONS.open_loss,
    expectedOORTrigger: true,
  },
};
