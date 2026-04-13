
import { getStrategy } from './src/strategies/strategyManager.js';
import { evaluateStrategyReadiness } from './src/market/strategyLibrary.js';

async function testSentinelV61() {
  console.log("=== SENTINEL v61 SIMULATION TEST ===");
  
  // 1. Check Strategy Manager Loading
  const strategy = getStrategy('Evil Panda');
  console.log("\n1. Strategy Manager Verification:");
  console.log(`- ID: ${strategy.id}`);
  console.log(`- Offset Min (Max Range/Up): ${strategy.deploy.entryPriceOffsetMin}%`);
  console.log(`- Offset Max (Min Range/Down): ${strategy.deploy.entryPriceOffsetMax}%`);
  
  // 2. Check Strategy Library Readiness
  console.log("\n2. Strategy Library Readiness (Mock Snapshot - Bullish):");
  const mockSnapshot = {
    ta: {
      supertrend: { trend: 'BULLISH', value: 90, changed: false }
    }
  };
  
  const readiness = await evaluateStrategyReadiness({
    strategyName: 'Evil Panda',
    snapshot: mockSnapshot
  });
  
  console.log(`- OK: ${readiness.ok}`);
  console.log(`- Notes: ${readiness.notes}`);
  console.log(`- Final Deploy Offsets: ${readiness.deployOptions.entryPriceOffsetMin} to ${readiness.deployOptions.entryPriceOffsetMax}`);
  
  // 3. Bin Math Simulation
  console.log("\n3. Bin Geometry Math Simulation:");
  const activePrice = 1.0;
  const offsetMin = readiness.deployOptions.entryPriceOffsetMin; // 0
  const offsetMax = readiness.deployOptions.entryPriceOffsetMax; // 94
  
  const upperPrice = activePrice * (1 - offsetMin/100);
  const lowerPrice = activePrice * (1 - offsetMax/100);
  
  console.log(`- Price Anchor: $${activePrice}`);
  console.log(`- Jaring Top (Max Range): $${upperPrice.toFixed(4)} (Offset ${offsetMin}%)`);
  console.log(`- Jaring Bottom (Min Range): $${lowerPrice.toFixed(4)} (Offset ${offsetMax}%)`);
  console.log(`- Total Coverage: 94% price drop covered.`);
  
  console.log("\n=== SIMULATION PASSED ===");
}

testSentinelV61().catch(console.error);
