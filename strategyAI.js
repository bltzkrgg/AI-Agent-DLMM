import { createMessage } from './agent/provider.js';

export async function getAIStrategy(context) {
  const res = await createMessage({
    messages: [
      {
        role: 'user',
        content: `Market: ${JSON.stringify(context)}
Give strategy: aggressive / conservative`,
      },
    ],
  });

  const text = res.content?.[0]?.text || '';

  if (text.includes('aggressive')) return 'AGGRESSIVE';
  if (text.includes('conservative')) return 'SAFE';

  return 'NORMAL';
}
