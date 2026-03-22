# 🦞 Meteora DLMM Bot

**Autonomous Meteora DLMM liquidity management agent for Solana, accessible via Telegram.**

Inspired by [Meridian](https://github.com/yunus-0x/meridian), built with a modular AI provider system and full Telegram integration.

---

## What It Does

- 🦅 **Hunter Alpha** — autonomously screens Meteora DLMM pools every 30 minutes against configurable thresholds (TVL, fee/TVL ratio, bin step, etc.) and deploys into the best candidate
- 🩺 **Healer Alpha** — monitors all open positions every 10 minutes; decides to STAY, CLAIM FEES, or CLOSE based on live range status and take-profit targets
- 📚 **Learn** — studies top LPers in candidate pools, extracts actionable lessons, and injects them into future agent cycles
- 🧬 **Evolve** — analyzes closed position history and auto-adjusts screening thresholds for better performance over time
- 🔔 **Notifications** — sends cycle reports and out-of-range alerts to your Telegram automatically
- 🧠 **Strategy System** — save, share, and reuse named DLMM strategies (spot, curve, bid-ask) with custom parameters and logic
- 🧪 **Dry Run Mode** — simulate everything without any on-chain transactions

---

## Architecture

```
src/
├── index.js                  # Entry point, Telegram bot, cron scheduling
├── config.js                 # Config & threshold management (user-config.json)
│
├── agent/
│   ├── claude.js             # Free-form AI chat agent (Telegram conversations)
│   └── provider.js           # AI provider abstraction (Anthropic, OpenRouter, OpenAI)
│
├── agents/
│   ├── hunterAlpha.js        # Autonomous pool screening & deployment agent
│   └── healerAlpha.js        # Autonomous position management agent
│
├── learn/
│   ├── lessons.js            # Learn from top LPers, save to lessons.json
│   └── evolve.js             # Auto-evolve thresholds from performance data
│
├── solana/
│   ├── meteora.js            # Meteora DLMM SDK integration
│   └── wallet.js             # Solana wallet & RPC connection
│
├── strategies/
│   ├── strategyManager.js    # Strategy CRUD (SQLite)
│   └── strategyHandler.js    # Telegram conversation flow for adding strategies
│
├── db/
│   └── database.js           # SQLite: positions, notifications, conversation history
│
└── monitor/
    └── positionMonitor.js    # Out-of-range position monitor (cron)
```

---

## Requirements

- Node.js v18+
- Solana wallet (dedicated bot wallet — never use your main wallet)
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- AI API key — see [Supported AI Providers](#supported-ai-providers)

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/your-username/meteora-dlmm-bot
cd meteora-dlmm-bot
npm install
```

### 2. Create `.env`

```bash
cp .env.example .env
```

Fill in all values:

```env
# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
ALLOWED_TELEGRAM_ID=your_telegram_user_id   # numeric ID from @userinfobot

# AI Provider — see section below
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Solana
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
WALLET_PRIVATE_KEY=your_base58_private_key   # bot wallet only!

# Bot
ADMIN_PASSWORD=your_strong_password
DRY_RUN=true    # always start with true!
```

### 3. Run in dry run mode (no real transactions)

```bash
npm run dry
```

### 4. Run live

```bash
npm start
```

---

## Supported AI Providers

Set `AI_PROVIDER` in `.env` to switch providers. No code changes needed.

| Provider | `AI_PROVIDER` | API Key Env | Default Model |
|---|---|---|---|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4o` |
| Custom | `custom` | `CUSTOM_AI_API_KEY` | — |

Override the model at any time:

```env
AI_MODEL=google/gemini-2.0-flash       # via OpenRouter
AI_MODEL=deepseek/deepseek-r1          # via OpenRouter
AI_MODEL=gpt-4o-mini                   # via OpenAI
```

---

## Telegram Commands

| Command | Description |
|---|---|
| `/start` | Show all commands |
| `/status` | Wallet balance & open positions |
| `/pools` | Screen top pool candidates now |
| `/hunt` | Run Hunter Alpha manually |
| `/heal` | Run Healer Alpha manually |
| `/strategies` | List all saved strategies |
| `/addstrategy <password>` | Add new strategy (step-by-step) |
| `/deletestrategy <password> <name>` | Delete a strategy |
| `/learn [pool_address]` | Learn from top LPers |
| `/lessons` | View saved lessons |
| `/evolve` | Auto-evolve screening thresholds |
| `/thresholds` | View current thresholds & performance stats |
| `/dryrun <on\|off> <password>` | Toggle dry run mode |

You can also send free-form messages — the bot understands natural language:

> *"Close all out-of-range positions"*
> *"What's the best pool right now?"*
> *"Open a position in pool ABC with 0.5 SOL"*

---

## Configuration (`user-config.json`)

Auto-created on first run. All fields are optional — defaults shown.

| Field | Default | Description |
|---|---|---|
| `dryRun` | `true` | Simulate transactions without submitting |
| `deployAmountSol` | `0.5` | SOL to deploy per new position |
| `maxPositions` | `3` | Max concurrent open positions |
| `minSolToOpen` | `0.07` | Min wallet SOL before opening a new position |
| `managementIntervalMin` | `10` | How often Healer Alpha runs (minutes) |
| `screeningIntervalMin` | `30` | How often Hunter Alpha runs (minutes) |
| `minFeeActiveTvlRatio` | `0.05` | Min fee/active-TVL ratio (5%) |
| `minTvl` | `10000` | Min pool TVL in USD |
| `maxTvl` | `150000` | Max pool TVL in USD |
| `takeProfitFeePct` | `5` | Close position when fees reach this % of deployed capital |
| `outOfRangeWaitMinutes` | `30` | Minutes out of range before Healer acts |
| `minFeeClaimUsd` | `1.0` | Min unclaimed fee USD before auto-claiming |

Thresholds can also be auto-tuned via `/evolve` after 5+ closed positions.

---

## Strategy System

Strategies define how positions are opened. Three built-in strategies are included:

| Name | Type | Description |
|---|---|---|
| Spot Balanced | `spot` | Even distribution, good for sideways markets |
| Curve Concentrated | `curve` | Concentrated at center, maximizes fees |
| Bid-Ask Wide | `bid_ask` | Wide spread, handles volatile assets |

To add a custom strategy via Telegram:
```
/addstrategy your_admin_password
```
The bot will walk you through name, description, type, parameters (JSON), and optional custom logic step by step.

---

## How Learning Works

### `/learn`
Fetches top LPers from candidate pools, analyzes their on-chain behavior (hold duration, entry/exit timing, rebalance patterns), and saves 4–8 concrete lessons to `lessons.json`. Cross-pool patterns are weighted more heavily. Saved lessons are automatically injected into Hunter and Healer agent prompts on every cycle.

### `/evolve`
After 5+ positions have been closed, analyzes the win rate, average PnL, and fee yield of each position against the thresholds that were active when it was opened — then adjusts `user-config.json` accordingly. Changes take effect immediately without restart.

---

## Security Recommendations

1. **Use a dedicated bot wallet** — never your main wallet. Only fund it with what you're willing to risk.
2. **Start with `DRY_RUN=true`** — verify behavior before going live.
3. **Keep `.env` out of version control** — it's in `.gitignore` by default.
4. **Use a strong `ADMIN_PASSWORD`** — it guards `/addstrategy`, `/dryrun`, and `/deletestrategy`.
5. **Use a private Helius RPC** for production — the public RPC is rate-limited.

---

## Recommended RPC

The default public Solana RPC is rate-limited. For stable operation, use [Helius](https://helius.dev) (free tier available):

```env
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

---

## Troubleshooting

**`Cannot find module 'better-sqlite3'`**
```bash
npm install better-sqlite3 --build-from-source
```

**`RPC 429 Too Many Requests`**
Switch to a private RPC (see above).

**Bot not responding in Telegram**
Make sure `ALLOWED_TELEGRAM_ID` is a numeric ID, not a `@username`.

**`xcode-select` errors on Mac**
```bash
xcode-select --install
npm install
```

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with dry run mode to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

---

## License

MIT
