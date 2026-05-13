---
sidebar_position: 5
title: OmniRoute Integration (Cost Optimization)
description: "Pair AdaL CLI with OmniRoute to compress tokens by 78-95%, auto-fallback across providers, and dramatically reduce AI costs."
sidebar_label: OmniRoute Proxy
---

# OmniRoute Integration — Save 78-95% on Token Costs

[OmniRoute](https://github.com/diegosouzapw/OmniRoute) is a free, open-source AI gateway that sits between AdaL CLI and your LLM providers. It compresses tokens, tracks costs, and auto-falls back to cheaper/free models when quota runs out.

## Why Pair AdaL with OmniRoute?

| Problem | OmniRoute Solution |
|---------|-------------------|
| Opus 4.6/4.7 burns credits fast | RTK+Caveman compression saves 78-95% on tool outputs |
| Quota runs out mid-session | Auto-fallback: Subscription → API Key → Cheap → Free |
| No visibility into spending | Real-time cost dashboard with per-model breakdown |
| Paying full price for file contents, git diffs | Command-aware compression strips redundancy before sending |

### Expected Savings (Heavy Opus Usage)

| Compression Mode | Input Savings | Best For |
|-----------------|---------------|----------|
| Lite | ~15% | Always-on safe default |
| Standard (Caveman) | ~30% | Daily coding, no quality risk |
| RTK | 60-90% | Tool outputs (git, grep, files) |
| **Stacked (RTK→Caveman)** | **78-95%** | Mixed coding sessions ✅ |

## Architecture

```
┌─────────────┐          ┌──────────────────────────┐         ┌───────────────┐
│  AdaL CLI   │──────────▶  OmniRoute (local)       │────────▶│  Anthropic    │
│             │          │  localhost:20128           │         │  OpenAI       │
│  BYOAK keys │          │                           │         │  Google       │
│  pointed at │          │  • Token compression      │         │  DeepSeek     │
│  OmniRoute  │          │  • Cost tracking          │         │  Free models  │
│             │          │  • Fallback routing        │         └───────────────┘
└─────────────┘          └──────────────────────────┘
```

:::warning Current Compatibility
AdaL CLI's BYOAK mode connects directly to providers. Support for custom base URLs via environment variables (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`) depends on the underlying SDK behavior. If AdaL doesn't pick up the env var automatically, a small source change may be needed — [open a feature request](https://github.com/SylphAI-Inc/adal-cli/issues) to track this.
:::

## Setup Guide

### Step 1: Install OmniRoute

```bash
npm install -g omniroute
omniroute
```

Dashboard opens at `http://localhost:20128`. API at `http://localhost:20128/v1`.

### Step 2: Configure OmniRoute Providers

1. Open `http://localhost:20128` → **Providers**
2. Add your API keys (Anthropic, OpenAI, Google, etc.)
3. Go to **Combos** → create a fallback chain:

```
Name: adal-coding
Strategy: Priority Fallback

[1] anthropic/claude-opus-4-7      (best quality)
[2] anthropic/claude-sonnet-4.5    (fast fallback)
[3] glm/glm-5.1                   (cheap — $0.5/1M)
[4] kr/claude-sonnet-4.5           (free via Kiro — never fails)
```

### Step 3: Create an OmniRoute API Key

1. Dashboard → **API Manager** (`/dashboard/api-manager`)
2. Click **Create API Key**
3. Name it `adal-cli`, select all permissions
4. Copy the key (format: `sk-xxxxxxxxxxxxxxxx-xxxxxxxxx`)

### Step 4: Enable Compression

1. Dashboard → **Context & Cache**
2. Set compression mode to **Stacked** (RTK→Caveman)
3. Optionally set `autoTriggerTokens` to auto-compress large requests

### Step 5: Configure AdaL CLI

Set environment variables in your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
# Point AdaL's BYOAK at OmniRoute
export ANTHROPIC_BASE_URL="http://localhost:20128"
export ANTHROPIC_API_KEY="sk-your-omniroute-key"
export OPENAI_BASE_URL="http://localhost:20128/v1"
export OPENAI_API_KEY="sk-your-omniroute-key"
export GOOGLE_BASE_URL="http://localhost:20128/v1"
export GOOGLE_API_KEY="sk-your-omniroute-key"
```

Then reload your shell:

```bash
source ~/.zshrc  # or source ~/.bashrc
```

### Step 6: Configure AdaL BYOAK

```bash
# In AdaL CLI, add your OmniRoute key as the provider key:
/byoak add anthropic sk-your-omniroute-key
/byoak add openai sk-your-omniroute-key
```

:::tip
When BYOAK is enabled, AdaL connects directly using the API key you provide. By setting `ANTHROPIC_BASE_URL` to OmniRoute's address, all traffic flows through the compression proxy transparently.
:::

### Step 7: Verify

Start AdaL CLI and use any model. Check the OmniRoute dashboard:
- **Logs** tab shows requests flowing through
- **Analytics** shows token savings
- **Compression** column shows reduction percentage

## Recommended Combos

### Budget-Conscious (Best Value)

```
[1] anthropic/claude-sonnet-4.5    (fast, capable)
[2] glm/glm-5.1                   ($0.5/1M — cheap backup)
[3] if/kimi-k2-thinking           (free unlimited via Qoder)
Compression: Stacked (RTK→Caveman)
```

### Maximum Quality (Heavy Opus)

```
[1] anthropic/claude-opus-4-7      (best reasoning)
[2] anthropic/claude-opus-4-6      (slightly cheaper Opus)
[3] anthropic/claude-sonnet-4.5    (fast fallback)
[4] kr/claude-sonnet-4.5           (free emergency via Kiro)
Compression: Standard (Caveman) — 30% savings, zero quality risk
```

### $0 Forever (All Free)

```
[1] kr/claude-sonnet-4.5           (free via Kiro)
[2] if/kimi-k2-thinking           (free via Qoder)
[3] pol/gpt-5                      (free via Pollinations)
[4] lc/longcat-flash-lite          (50M tokens/day free)
Compression: Aggressive — 50% savings
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| AdaL ignores `ANTHROPIC_BASE_URL` | Ensure BYOAK is enabled (`/byoak`) and the key matches |
| Connection refused | Verify OmniRoute is running (`omniroute` or `pm2 status`) |
| 401 Unauthorized | Check API key in OmniRoute's API Manager |
| Models not appearing | Use `/model` in AdaL and select any model — OmniRoute routes automatically |
| Compression too aggressive | Switch to "Standard" or "Lite" in OmniRoute dashboard |

## Cost Comparison Example

**Without OmniRoute** (direct Opus 4.7):
- 500K input tokens/day × $15/1M = $7.50/day → **$225/month**

**With OmniRoute** (Stacked compression, ~80% savings on eligible):
- 500K tokens → ~100K sent after compression
- 100K × $15/1M = $1.50/day → **$45/month**
- **Savings: $180/month** (80% reduction)

:::note
Compression savings vary by content type. Tool outputs (git diff, grep, file contents) compress 80-95%. Pure reasoning/code generation compresses less (~15-30%). Real-world coding sessions average 50-70% overall savings.
:::

## Further Reading

- [OmniRoute GitHub](https://github.com/diegosouzapw/OmniRoute)
- [OmniRoute Compression Guide](https://github.com/diegosouzapw/OmniRoute/blob/main/docs/COMPRESSION_GUIDE.md)
- [OmniRoute CLI Tools Setup](https://github.com/diegosouzapw/OmniRoute/blob/main/docs/CLI-TOOLS.md)
- [BYOAK Configuration](./bring-your-own-api-key.md)

---

**Related:** [BYOAK](./bring-your-own-api-key.md) · [Local Models](./local-models.md) · [Models](../01-getting-started/models.md)
