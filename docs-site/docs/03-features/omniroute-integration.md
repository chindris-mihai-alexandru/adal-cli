---
sidebar_position: 5
title: Token Compression (adal-compress)
description: "Save 30-70% on token costs with transparent compression. Zero config — just run adal-compress instead of adal."
sidebar_label: Token Compression
---

# Token Compression — Save 30-70% on Credits

`adal-compress` is a zero-config compression proxy that makes your AdaL credits last 30-70% longer. Run it instead of `adal` — everything else stays the same.

## Quick Start

```bash
# From the adal-compress directory:
cd adal-compress
npm link

# Then just use adal-compress instead of adal:
adal-compress
```

That's it. Same auth, same credits, same models. Just fewer tokens per request.

## How It Works

```
┌─────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│  AdaL CLI   │────▶│  adal-compress proxy  │────▶│  adal.sylph.ai   │
│  (unchanged)│     │  localhost:19876      │     │  (real backend)  │
│             │     │                       │     │                  │
│  ADAL_APP_URL     │  • Caveman prose rules │     │  Auth ✅          │
│  = proxy    │     │  • RTK tool output    │     │  Credits ✅       │
│             │     │  • Whitespace strip   │     │  Models ✅        │
└─────────────┘     └──────────────────────┘     └──────────────────┘
```

`adal-compress` sets `ADAL_APP_URL` to a local proxy. AdaL's backend thinks it's talking to `adal.sylph.ai`, but requests hit the proxy first. The proxy:

1. Parses message bodies
2. Applies compression rules to eligible content
3. Forwards to `adal.sylph.ai` with all auth headers intact
4. Streams responses back untouched

## What Gets Compressed

### Prose (Caveman-style, ~30-50% savings)

Natural language filler that carries zero information:

| Before | After |
|--------|-------|
| "In order to fix this issue" | "to fix this issue" |
| "I think you should basically" | (removed) |
| "The system is able to handle" | "system can handle" |
| "due to the fact that" | "because" |
| "it is important to note that" | "note:" |
| "very extremely quite rather" | (removed) |

### Tool Outputs (RTK-style, ~60-90% savings)

Command outputs that LLMs don't need in full:

| Type | What's Kept |
|------|-------------|
| `git diff` | Only +/- lines and headers (no unchanged context) |
| `git status` | File list only (no hint text) |
| `npm install` | Errors + final summary |
| `test output` | Failures + summary (passes dropped) |
| `ls`/`find` | First 30 entries + total count |

### What's NEVER Compressed

- Code blocks (fenced + inline)
- URLs and file paths
- JSON and technical data
- Numbers, constraints, and specifics
- Environment variables and function signatures
- **All assistant responses** (never touched)

## Usage Options

```bash
# Standard (recommended)
adal-compress

# Verbose — see per-request savings
adal-compress -v

# Print savings every 30 seconds
adal-compress --stats 30

# Pass flags to adal
adal-compress -- --yolo

# Disable compression (passthrough)
ADAL_COMPRESS_DISABLED=1 adal-compress
```

## Session Summary

When you exit, you'll see your savings:

```
  📊 Session summary:
     Requests compressed: 47/52
     Tokens saved: 12,340 (42.1%)
     Original: ~29,310 tokens
     Sent: ~16,970 tokens
```

## Expected Savings by Model Usage

| Usage Pattern | Typical Savings |
|---------------|----------------|
| Heavy Opus 4.6/4.7 coding | 35-50% (tool outputs dominate) |
| Mixed Sonnet + Opus | 30-45% |
| Mostly conversation (low tools) | 20-30% |
| Build/test-heavy sessions | 50-70% (RTK rules shine) |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `adal-compress: command not found` | Run `npm link` in the `adal-compress/` directory |
| AdaL behaves differently | Set `ADAL_COMPRESS_DISABLED=1` to verify it's compression-related |
| Auth issues | Compression proxy passes all headers through — check normal `adal` first |
| Port 19876 in use | Edit `PROXY_PORT` in `bin/adal-compress.mjs` |

## Tests

```bash
cd adal-compress
npm test   # 17 tests covering all compression rules
```

---

**Related:** [BYOAK](./bring-your-own-api-key.md) · [Models](../01-getting-started/models.md)
