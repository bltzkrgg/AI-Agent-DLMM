const PROVIDERS = new Set(['anthropic', 'openrouter', 'openai', 'custom', 'groq', 'huggingface']);

export function getAIProvider() {
  const provider = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw new Error(`AI_PROVIDER tidak didukung: ${provider}. Pilihan: ${Array.from(PROVIDERS).join(', ')}`);
  }
  return provider;
}

export function getRequiredEnvKeys({ requireTrading = true, requireGmgn = false } = {}) {
  const provider = getAIProvider();
  const required = ['TELEGRAM_BOT_TOKEN', 'ALLOWED_TELEGRAM_ID'];

  const providerKeyMap = {
    anthropic: 'ANTHROPIC_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    openai: 'OPENAI_API_KEY',
    custom: 'CUSTOM_AI_BASE_URL',
    groq: 'GROQ_API_KEY',
    huggingface: 'HUGGINGFACE_API_KEY',
  };
  required.push(providerKeyMap[provider]);

  if (requireTrading) {
    required.push('WALLET_PRIVATE_KEY');
    if (!process.env.HELIUS_API_KEY && !process.env.SOLANA_RPC_URL) {
      required.push('HELIUS_API_KEY or SOLANA_RPC_URL');
    }
  }
  if (requireGmgn) {
    required.push('GMGN_API_KEY');
  }

  return required;
}

export function validateRuntimeEnv({ requireTrading = true, requireGmgn = false } = {}) {
  const missing = [];
  for (const key of getRequiredEnvKeys({ requireTrading, requireGmgn })) {
    if (key.includes(' or ')) {
      const [left, right] = key.split(' or ');
      if (!process.env[left] && !process.env[right]) missing.push(key);
      continue;
    }
    if (!process.env[key]) missing.push(key);
  }
  return { provider: getAIProvider(), missing };
}
