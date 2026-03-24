import { evolveStrategy } from './evolution.js';
import { evolveWithAI } from './aiEvolution.js';

cron.schedule('*/15 * * * *', async () => {
  console.log('🧬 Evolution running...');

  evolveStrategy();

  const ai = await evolveWithAI();
  if (ai) {
    console.log('🤖 AI suggests:', ai);
  }
});
