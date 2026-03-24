import Anthropic from '@anthropic-ai/sdk';

let client;

function getClient() {
  if (client) return client;

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export async function createMessage(params) {
  const c = getClient();

  return c.messages.create({
    model: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
    max_tokens: params.maxTokens || 2000,
    messages: params.messages,
    system: params.system,
    tools: params.tools,
  });
}
