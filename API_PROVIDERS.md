# AI API Providers Setup Guide

This bot supports multiple AI API providers. You can use **free or paid** models from any of them.

## Supported Providers

| Provider | Type | Setup | Free Models | Paid Models |
|----------|------|-------|------------|------------|
| **OpenRouter** | Aggregator | `AI_PROVIDER=openrouter` + `OPENROUTER_API_KEY` | ✅ Yes (`:free`) | ✅ Yes |
| **OpenAI** | Proprietary | `AI_PROVIDER=openai` + `OPENAI_API_KEY` | ❌ No | ✅ Yes |
| **Anthropic** | Proprietary | `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` | ❌ No | ✅ Yes |
| **Groq** | Fast Inference | `AI_PROVIDER=groq` + `GROQ_API_KEY` | ✅ Yes | ❌ No |
| **HuggingFace** | Model Hub | `AI_PROVIDER=huggingface` + `HUGGINGFACE_API_KEY` | ✅ Yes | ✅ Yes |
| **Custom** | Self-hosted | `AI_PROVIDER=custom` + `CUSTOM_AI_BASE_URL` + `CUSTOM_AI_API_KEY` | Varies | Varies |

---

## Setup Instructions

### 1. OpenRouter (Recommended - Best for free models)

**Why choose it?** 
- 100+ models available (including free)
- Best compatibility with bot features
- Easiest setup with free models

**Setup:**
```bash
# 1. Get API key from https://openrouter.ai/keys
# 2. Add to .env:
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your_key_here

# 3. Use free models with :free suffix:
AI_MODEL=openai/gpt-4o-mini:free
# or
AI_MODEL=qwen/qwen3.6-plus:free
```

**Available Free Models:**
```
openai/gpt-4o-mini:free
qwen/qwen3.6-plus:free
meta-llama/llama-2-70b-chat:free
mistralai/mistral-7b-instruct:free
```

**Check all available models:**
```bash
curl https://openrouter.ai/api/v1/models \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" | jq '.data[] | select(.pricing.prompt == "0") | .id'
```

---

### 2. Groq (Fastest free option)

**Why choose it?**
- Very fast inference (perfect for trading bots)
- Free tier available
- No rate limits on free tier

**Setup:**
```bash
# 1. Get API key from https://console.groq.com
# 2. Add to .env:
AI_PROVIDER=groq
GROQ_API_KEY=your_key_here

# 3. Use Groq models:
AI_MODEL=mixtral-8x7b-32768
# or
AI_MODEL=llama2-70b-4096
```

**Available Free Models:**
```
mixtral-8x7b-32768
llama2-70b-4096
gemma-7b-it
```

---

### 3. OpenAI

**Why choose it?**
- Highest quality models
- Most reliable
- Paid only, but worth it

**Setup:**
```bash
# 1. Get API key from https://platform.openai.com/api-keys
# 2. Add to .env:
AI_PROVIDER=openai
OPENAI_API_KEY=your_key_here

# 3. Use OpenAI models:
AI_MODEL=gpt-4o-mini
# or (cheapest)
AI_MODEL=gpt-4o-mini
```

---

### 4. Anthropic

**Why choose it?**
- Claude models have excellent reasoning
- Built-in tool use support
- Good context window

**Setup:**
```bash
# 1. Get API key from https://console.anthropic.com
# 2. Add to .env:
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_key_here

# 3. Use Claude models:
AI_MODEL=claude-haiku-4-5
# or (better quality)
AI_MODEL=claude-opus-4-6
```

---

### 5. HuggingFace (For advanced users)

**Why choose it?**
- Access to 200k+ models
- Inference API for any model
- Free tier available

**Setup:**
```bash
# 1. Get API key from https://huggingface.co/settings/tokens
# 2. Add to .env:
AI_PROVIDER=huggingface
HUGGINGFACE_API_KEY=your_key_here

# 3. Use HuggingFace models:
AI_MODEL=mistral-7b-instruct-v0.1
```

---

### 6. Custom (Self-hosted)

**Why choose it?**
- Run your own model server
- No vendor lock-in
- Full privacy

**Setup:**
```bash
# For local Ollama server:
AI_PROVIDER=custom
CUSTOM_AI_BASE_URL=http://localhost:11434/v1
CUSTOM_AI_API_KEY=ollama

# For other servers, adjust CUSTOM_AI_BASE_URL accordingly
AI_MODEL=mistral:7b
```

---

## Runtime Model Selection

### Check Current Model
```
/model
```
Shows active provider, model, and all configuration slots.

### Test Model
```
/testmodel
```
Tests if current model is working and responsive.

### Switch Model
```
/model <model_id>
```

**Examples:**
```
/model openai/gpt-4o-mini:free
/model claude-haiku-4-5
/model mixtral-8x7b-32768
```

### Reset to Default
```
/model reset
```

---

## Troubleshooting

### ✅ FIXED: Empty Response from Minimax Models

**Status:** PERMANENTLY FIXED (v2.0.1+)

**Original Problem:** Minimax models (minimax-m2.5, minimax-m2.7) on OpenRouter returned empty responses:
```
⚠️ Attempt 1: Empty response from minimax/minimax-m2.5
Model "minimax/minimax-m2.5" returned empty content. Model mungkin overloaded...
```

**Root Cause:** Minimax models fail silently on OpenRouter — they don't return errors, just empty content. This happens regardless of tools parameter or request format.

**Solution Implemented:** Minimax models are now PERMANENTLY BLOCKED from use.

**How It Works:**
1. **Automatic Detection** — System detects if minimax is configured (via AI_MODEL env, /model command, or config file)
2. **Immediate Blocking** — Minimax is rejected before any API call is made
3. **Intelligent Fallback** — System automatically switches to a working model:
   - **OpenRouter users** → `qwen/qwen3.6-plus:free` (proven working)
   - **Groq users** → `mixtral-8x7b-32768` (if GROQ_API_KEY set)
   - **OpenAI users** → `gpt-4o-mini` (if OPENAI_API_KEY set)
   - **Anthropic users** → `claude-haiku-4-5` (if ANTHROPIC_API_KEY set)
4. **User Notification** — Warning logged so you know why model changed
5. **Never Suggested** — Minimax won't appear in model suggestions

**What Users See:**
```
⚠️ Model "minimax/minimax-m2.5" is blocked (known to fail). Switching to fallback: qwen/qwen3.6-plus:free
✅ Model check OK: qwen/qwen3.6-plus:free
```

**Defense-in-Depth:**
- `resolveModel()` blocks it at priority level
- `createMessage()` blocks it as backup safety
- `fetchFreeModels()` excludes it from suggestions
- BLOCKED_MODELS Set checked at 3+ locations

**If you still see minimax errors:**
1. Check `.env` and remove any `AI_MODEL=minimax/...` line
2. Clear session: `/model reset`
3. Restart bot: `npm start`

The system will then use intelligent fallback based on your configured provider keys.

### Model Not Found (404)

**Problem:** Selected model doesn't exist
```
Model tidak tersedia: unknown-model/xyz
```

**Solution:**
- Use `/model` to see available models
- Check provider's documentation for correct model names
- Try free fallback model: `/model openai/gpt-4o-mini:free`

### Rate Limited (429)

**Problem:** Too many requests to API

**Solution:**
- Bot automatically retries with exponential backoff
- Wait a few minutes before trying again
- If persistent, consider paid tier or different provider

### Authentication Failed (401/403)

**Problem:** Invalid API key

**Solution:**
```bash
# Check .env file for:
# 1. Correct environment variable name
# 2. Correct API key value
# 3. API key hasn't been revoked

# Test with curl:
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

---

## Cost Comparison

### Free Options
- **OpenRouter** (free tier models) - Free
- **Groq** - Free
- **HuggingFace** - Free tier ~30k API calls/month
- **Self-hosted Ollama** - Free (CPU/GPU cost)

### Cheapest Paid
- **OpenRouter (free models)** - $0
- **OpenAI gpt-4o-mini** - $0.00015 per 1K tokens
- **Groq** - $0
- **Anthropic Claude-Haiku** - $0.80 per 1M input tokens

### Best Value
- **OpenRouter** with free models for testing
- **Groq** for production (fast + free)
- **OpenAI** if you want best quality

---

## Configuration Examples

### Setup 1: Free OpenRouter
```bash
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
AI_MODEL=openai/gpt-4o-mini:free
```

### Setup 2: Fast Groq
```bash
AI_PROVIDER=groq
GROQ_API_KEY=gsk_...
AI_MODEL=mixtral-8x7b-32768
```

### Setup 3: Quality OpenAI
```bash
AI_PROVIDER=openai
OPENAI_API_KEY=sk-proj-...
AI_MODEL=gpt-4o-mini
```

### Setup 4: Reasoning Anthropic
```bash
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
AI_MODEL=claude-opus-4-6
```

### Setup 5: All Models Combined (OpenRouter Aggregator)
```bash
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
# Switch between any model:
/model openai/gpt-4o:free
/model claude-opus-4-6
/model mixtral-8x7b-32768:free
/model gemini-pro
```

---

## For Bot Developers

### Model Detection
```javascript
const activeModel = resolveModel(cfg.generalModel);
console.log('Using model:', activeModel);
```

### Force Specific Provider
```javascript
const response = await createMessage({
  forceModel: 'openai/gpt-4o-mini:free', // Override everything
  messages: [...],
});
```

### Auto-fallback on Error
Bot automatically falls back to `FALLBACK_AI_MODEL` (default: `openai/gpt-4o-mini:free`) if:
- Current model returns 404 (not found)
- Current model returns 500+ error
- Current model times out
- Current model returns empty response

---

## Blocked Models (DO NOT USE)

⛔ **MINIMAX MODELS ARE BLOCKED AND WILL NOT WORK:**
```
❌ minimax/minimax-m2.5
❌ minimax/minimax-m2.7
❌ minimax-m2.5
❌ minimax-m2.7
```

**Why?** These models fail silently on OpenRouter by returning empty responses. The system automatically blocks them and switches to `qwen/qwen3.6-plus:free` instead.

**If you see "Model minimax..." in config:**
- Remove it from `.env` (if set as `AI_MODEL`)
- Or use `/model reset` to clear session override
- System will auto-switch to working model

---

## Common Mistakes

❌ **Don't:**
- Use model name without provider: `gpt-4o-mini` (should be `openai/gpt-4o-mini`)
- Put API key in code (use `.env`)
- Mix providers without updating `.env`
- Use `:free` suffix with non-free providers
- **Use minimax models** (they are blocked — use qwen instead)

✅ **Do:**
- Test model with `/testmodel` before reporting issues
- Use free models for testing before switching to paid
- Keep API keys in `.env` file (add to `.gitignore`)
- Check provider's model list before using model ID
- Use `qwen/qwen3.6-plus:free` as fallback if unsure

---

## Support

- **OpenRouter**: https://openrouter.ai/docs
- **Groq**: https://console.groq.com/docs
- **OpenAI**: https://platform.openai.com/docs
- **Anthropic**: https://docs.anthropic.com
- **HuggingFace**: https://huggingface.co/docs/api-inference
