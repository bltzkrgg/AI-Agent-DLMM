import { getStrategy } from './src/strategies/strategyManager.js';

const tests = [
  'Evil Panda',
  'evil panda',
  'Evil_Panda',
  'Evil Panda (Adaptive)',
  'EVIL PANDA',
  'non-existent'
];

console.log('--- Testing Fuzzy Strategy Lookup ---');
tests.forEach(name => {
  const s = getStrategy(name);
  console.log(`Input: "${name}" -> Result: ${s ? s.name : 'NULL'}`);
});
