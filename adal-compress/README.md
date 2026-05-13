# adal-compress

Transparent token compression for AdaL CLI — saves 30-70% on eligible tokens. Zero config.

## How It Works

```
┌─────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│  AdaL CLI   │────▶│  adal-compress proxy  │────▶│  adal.sylph.ai   │
│  (unchanged)│     │  localhost:19876      │     │  (real backend)  │
│             │     │                       │     │                  │
│  ADAL_APP_URL     │  • Caveman rules      │     │  Auth ✅          │
│  = proxy    │     │  • Tool output RTK    │     │  Credits ✅       │
│             │     │  • Whitespace strip   │     │  Models ✅        │
└─────────────┘     └──────────────────────┘     └──────────────────┘
```

**Nothing changes** about how you use AdaL — same auth, same credits, same models. The proxy just compresses messages before they leave your machine, so you use fewer tokens per request.

## Install

```bash
cd adal-compress
npm link   # Makes `adal-compress` available globally
```

## Usage

```bash
# Instead of `adal`, just run:
adal-compress

# Verbose mode (see per-request savings):
adal-compress -v

# Print savings summary every 30 seconds:
adal-compress --stats 30

# Pass flags to adal:
adal-compress -- --yolo

# Disable compression (passthrough):
ADAL_COMPRESS_DISABLED=1 adal-compress
```

## What Gets Compressed

### Prose (Caveman-style, ~30-50% savings)
| Before | After |
|--------|-------|
| "In order to fix this issue" | "to fix this issue" |
| "I think you should basically" | "" (removed) |
| "The system is able to handle" | "system can handle" |
| "due to the fact that" | "because" |
| "it is important to note that" | "note:" |
| "very extremely quite rather" | (removed — zero info) |

### Tool Outputs (RTK-style, ~60-90% savings)
| Type | Compression |
|------|-------------|
| `git diff` | Removes unchanged context lines — keeps only +/- |
| `git status` | Strips hints, keeps file list only |
| `npm install` | Keeps errors + final summary |
| `test output` | Keeps failures + summary, drops passing tests |
| `ls`/`find` | Truncates to 30 entries + total count |

### What's NEVER Compressed
- ✅ Code blocks (fenced + inline)
- ✅ URLs and file paths
- ✅ JSON and technical data
- ✅ Numbers and constraints
- ✅ Environment variables
- ✅ Function signatures
- ✅ Assistant responses (never touched)

## Session Summary

When you exit, you'll see:
```
  📊 Session summary:
     Requests compressed: 47/52
     Tokens saved: 12,340 (42.1%)
     Original: ~29,310 tokens
     Sent: ~16,970 tokens
```

## How It Integrates

AdaL CLI respects the `ADAL_APP_URL` environment variable to configure its backend URL. `adal-compress` sets this to a local proxy that:

1. Receives requests from AdaL's backend
2. Parses message bodies
3. Applies compression rules
4. Forwards to `adal.sylph.ai` with all auth headers intact
5. Streams responses back untouched

## Tests

```bash
npm test  # 17 tests covering all compression rules
```

## Temporary Solution

This works until AdaL CLI adds native compression or custom base URL support.
Feature request: https://github.com/SylphAI-Inc/adal-cli/issues/125

## License

MIT
