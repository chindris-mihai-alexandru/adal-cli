# adal-omniroute-bridge

Route AdaL CLI through [OmniRoute](https://github.com/diegosouzapw/OmniRoute) for token compression and cost optimization.

## Why?

AdaL CLI v1.1.3 doesn't natively support custom base URLs for providers. This bridge ensures all LLM requests flow through OmniRoute using a multi-layer interception strategy:

1. **Layer 1** — SDK env vars (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`) — works if the bundled SDK respects them
2. **Layer 2** — `HTTP_PROXY`/`HTTPS_PROXY` env vars — catches at transport level (aiohttp respects these)
3. **Layer 3** — Local intercept proxy rewrites CONNECT tunnels to OmniRoute

## Prerequisites

- [AdaL CLI](https://docs.sylph.ai) installed (`npm install -g @sylphai/adal-cli`)
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute) installed and running (`npm install -g omniroute && omniroute`)

## Install

```bash
cd adal-omniroute-bridge
npm install
npm link   # Makes `adal-omniroute` available globally
```

## Usage

```bash
# Start OmniRoute first (in a separate terminal)
omniroute

# Then launch AdaL through the bridge
adal-omniroute

# With custom OmniRoute port
adal-omniroute --port 20128

# Remote OmniRoute instance
adal-omniroute --omniroute-url http://my-server:20128

# Pass flags to AdaL
adal-omniroute -- --yolo

# Env vars only (no intercept proxy)
adal-omniroute --no-proxy
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OMNIROUTE_URL` | `http://localhost:20128` | OmniRoute base URL |
| `OMNIROUTE_API_KEY` | (none) | OmniRoute API key (overrides provider keys) |

## How It Works

```
┌──────────────────┐     ┌───────────────────┐     ┌──────────────┐     ┌──────────────┐
│  adal-omniroute  │────▶│  AdaL CLI         │────▶│  Intercept   │────▶│  OmniRoute   │──▶ Providers
│  (launcher)      │     │  (env modified)   │     │  Proxy :18199│     │  :20128      │
└──────────────────┘     └───────────────────┘     └──────────────┘     └──────────────┘

Layer 1: ANTHROPIC_BASE_URL=http://localhost:20128
Layer 2: HTTPS_PROXY=http://127.0.0.1:18199
Layer 3: Proxy intercepts CONNECT to api.anthropic.com → redirects to OmniRoute
```

## OmniRoute Configuration Tips

1. **Enable Stacked Compression** (Dashboard → Context & Cache):
   - Mode: Stacked (RTK→Caveman) — 78-95% savings on tool outputs

2. **Create a Combo** (Dashboard → Combos):
   ```
   Name: adal-coding
   Strategy: Priority Fallback
   [1] anthropic/claude-opus-4-7
   [2] anthropic/claude-sonnet-4.5
   [3] glm/glm-5.1 ($0.5/1M)
   [4] kr/claude-sonnet-4.5 (free)
   ```

3. **Create an API Key** (Dashboard → API Manager) and set `OMNIROUTE_API_KEY`

## Temporary Solution

This bridge is a workaround until AdaL CLI officially supports custom base URLs.
Feature request: https://github.com/SylphAI-Inc/adal-cli/issues/125

## License

MIT
