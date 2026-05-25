---
title: Token Compression
sidebar_position: 10
---

# Token Compression

AdaL includes a transparent token compression system that reduces your credit usage by 30-70% without sacrificing quality.

## Overview

Token compression works at multiple layers:

| Layer | What it compresses | Savings | Tool |
|-------|-------------------|---------|------|
| **Input** | Verbose phrases, filler, articles | ~40% | `adal-compress` proxy |
| **Tool Output** | Git diff, npm logs, test results | ~60% | `adal-compress` proxy |
| **Instructions** | AGENTS.md, CLAUDE.md, context files | ~46% | `compress-memory` |
| **Tool Schemas** | MCP tool descriptions | ~70-97% | `adal-compress` proxy |
| **Output** | Assistant verbosity | ~65% | `adal-compress` skill |

## Quick Start

### AdaL CLI

```bash
# Instead of running `adal`, run:
adal-compress

# That's it. Same auth, same models, 30-70% less token usage.
```

### AdaL Desktop

```bash
# Option 1: Launch Desktop through the proxy
adal-compress-desktop

# Option 2: Run proxy as daemon (all instances benefit)
adal-compress-desktop --daemon
# Then add to ~/.zshrc: export ADAL_APP_URL=http://localhost:PORT
```

### Pre-compress Memory Files

```bash
# Compress AGENTS.md in current project
compress-memory

# Compress global instruction files
compress-memory --global

# Preview savings without changing files
compress-memory --dry-run
```

## How It Works

### Architecture

```
User Prompt → [adal-compress proxy] → AdaL Backend → LLM Provider
                    ↓
         Strips filler, normalizes,
         compresses tool outputs,
         deduplicates system prompts
```

The compression proxy sits between AdaL and the backend API. It:
1. Intercepts outgoing LLM requests
2. Compresses message content (preserving code, paths, URLs)
3. Forwards to the real backend with auth intact
4. Streams responses back untouched

### What Gets Compressed

**Natural language prose:**
- "In order to" → "to"
- "Due to the fact that" → "because"
- "I think", "basically", "it's worth noting" → removed
- Articles ("the", "a", "an") before common nouns → removed

**Tool outputs:**
- Git diff: context lines removed (keeps +/- only)
- npm install: keeps errors + summary only
- Test results: keeps failures + summary
- File listings: truncated to 30 entries + count

**Tool schemas:**
- Descriptions shortened to first sentence (max 80 chars)
- Parameter descriptions stripped (structure preserved)
- Saves 70-97% on tool definition tokens

### What's NEVER Compressed

- Code blocks, diffs, commands
- File paths, URLs, API endpoints
- JSON objects and arrays
- Function signatures, import statements
- Numbers with units
- Environment variables
- Assistant responses (never touched)

## Configuration

### Environment Variables

| Variable | Effect |
|----------|--------|
| `ADAL_COMPRESS_VERBOSE=1` | Show per-request compression stats |
| `ADAL_COMPRESS_DISABLED=1` | Disable compression (passthrough) |

### CLI Flags

```bash
adal-compress -v              # Verbose mode
adal-compress --stats 30      # Print savings every 30 seconds
adal-compress -- --yolo       # Pass flags to adal
```

## Output Compression Skill

Beyond request compression, AdaL includes an output compression skill that makes the assistant respond more concisely:

- Install the skill at `.claude/skills/adal-compress/SKILL.md` or `.agents/skills/adal-compress/SKILL.md`
- The assistant will use terse bullets instead of paragraphs
- Technical accuracy is fully preserved
- Average 65% reduction in output tokens

## Benchmarks

Real compression measurements on typical agent workloads:

| Content Type | Before | After | Saved |
|-------------|--------|-------|-------|
| System prompt (large) | 4,820 tok | 3,100 tok | 36% |
| Git diff (50 files) | 12,400 tok | 4,200 tok | 66% |
| npm install output | 3,200 tok | 180 tok | 94% |
| Test results (passing) | 2,800 tok | 12 tok | 99% |
| AGENTS.md (typical) | 1,400 tok | 800 tok | 43% |
| Tool schemas (20 tools) | 8,000 tok | 1,200 tok | 85% |

## Compatibility with Caveman

AdaL Compress is compatible with and complementary to the [Caveman](https://github.com/JuliusBrussee/caveman) ecosystem:

- **Caveman skill** focuses on output compression (making the model talk terse)
- **AdaL Compress** focuses on input/context/tool compression (reducing what goes IN)
- **Both together** provide maximum savings across all token directions

To use both:
```bash
# Install Caveman skill
curl -fsSL https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh | bash

# Run AdaL with compression proxy (handles input side)
adal-compress
```

## Troubleshooting

### Compression seems too aggressive

If you notice lost context, check specific patterns:
```bash
adal-compress -v  # See what's being compressed per-request
```

You can disable temporarily:
```bash
ADAL_COMPRESS_DISABLED=1 adal
```

### Desktop not routing through proxy

Verify the proxy is running:
```bash
cat ~/.adal/compress-proxy.json
# Should show: { "pid": ..., "port": ..., "url": "http://localhost:..." }
```

Check Desktop's server URL setting matches the proxy address.
