import { createMessage } from './agent/provider.js';
import { getPerformance } from './tracker.js';

export async function evolveWithAI() {
  const perf = getPerformance();
  if (!perf) return null;

  const res = await createMessage({
    messages: [
      {
        role: 'user',
        content: `
Performance:
${JSON.stringify(perf)}

Adjust strategy:
- risk level
- TP/SL
- position size

Return JSON only
`,
      },
    ],
  });

  const text = res.content?.[0]?.text;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
