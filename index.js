import 'dotenv/config';
import cron from 'node-cron';

import { initSolana } from './wallet.js';
import { runHunterAlpha } from './agents/hunterAlpha.js';
import { runHealerAlpha } from './agents/healerAlpha.js';

initSolana();

console.log('🚀 Bot started');

cron.schedule('*/5 * * * *', async () => {
  await runHunterAlpha();
});

cron.schedule('*/3 * * * *', async () => {
  await runHealerAlpha();
});
