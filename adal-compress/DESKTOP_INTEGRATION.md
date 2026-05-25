# Desktop Integration — Feature Spec

**Date**: 2025-05-25  
**Author**: AdaL  
**Status**: Implementation ready  
**Priority**: P1 — token waste on Desktop is the primary pain point

## TL;DR

AdaL Desktop burns tokens because its sidecar process has no compression layer. The CLI has `adal-compress` but Desktop bypasses it. This spec defines how to wire compression for Desktop at three levels of effort.

---

## Problem Statement

- Desktop spawns a sidecar (opencode CLI binary) that talks directly to LLM providers
- The sidecar inherits shell env BUT `ADAL_APP_URL` is not explicitly injected
- No compression happens on Desktop requests — full verbose context every turn
- Result: ~50% weekly token budget burned "for almost nothing"

## Root Cause Analysis

From `opencode-fork/packages/desktop/src-tauri/src/cli.rs`:

```rust
// Line 376-390: Environment vars set for sidecar
let mut envs = vec![
    ("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY", "true"),
    ("OPENCODE_EXPERIMENTAL_FILEWATCHER", "true"),
    ("OPENCODE_CLIENT", "desktop"),
    ("XDG_STATE_HOME", state_dir),
];
// Note: NO ADAL_APP_URL injection
```

The sidecar gets merged with user's shell env (`load_shell_env`), so if `ADAL_APP_URL` is in shell profile it WILL work. But this is not documented and most users won't have it set.

## Solution Architecture

### Level 1 — User-side (NOW, no code changes needed)

Add `ADAL_APP_URL` to shell profile → Desktop sidecar inherits it:

```bash
# ~/.zshrc or ~/.bashrc
export ADAL_APP_URL=http://localhost:$(cat ~/.adal/compress-proxy.json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['port'])" 2>/dev/null || echo 9876)
```

Or use `adal-compress-desktop --daemon` which starts the proxy and writes the PID file.

### Level 2 — Desktop Rust change (opencode-fork PR)

In `cli.rs`, inject `ADAL_APP_URL` into the sidecar env when compression is enabled:

```rust
// In spawn_command(), after building envs vec:
if let Ok(proxy_url) = std::env::var("ADAL_APP_URL") {
    envs.push(("ADAL_APP_URL".to_string(), proxy_url));
}

// Or read from ~/.adal/compress-proxy.json
if let Some(proxy_info) = read_compress_proxy_config() {
    envs.push(("ADAL_APP_URL".to_string(), proxy_info.url));
}
```

### Level 3 — Desktop Settings UI (opencode-fork PR)

Add compression toggle to Desktop settings:

```typescript
// In settings UI
interface CompressionSettings {
  enabled: boolean;          // Master toggle
  proxyPort: number | null;  // Custom port (null = auto)
  autoStart: boolean;        // Start proxy with Desktop
  showSavings: boolean;      // Show token savings in UI
}
```

Store in Tauri settings store alongside `DEFAULT_SERVER_URL_KEY`.

### Level 4 — Native middleware (opencode-fork PR, biggest impact)

Add compression directly into the TypeScript session layer:

```typescript
// In packages/opencode/src/session/prompt.ts
// Before sending to provider:
if (Config.compression.enabled) {
  messages = compressMessages(messages);
  tools = compressToolSchemas(tools);
}
```

This eliminates the need for an external proxy entirely. Compression becomes a native feature.

## Implementation Order

1. **Done**: `adal-compress-desktop` launcher (this repo)
2. **Done**: `compress-memory` utility (this repo)
3. **Done**: Output compression skill (this repo)
4. **Done**: Documentation (this repo)
5. **Next**: opencode-fork PR — inject `ADAL_APP_URL` passthrough in `cli.rs`
6. **Next**: opencode-fork PR — Settings UI toggle
7. **Future**: Native compression middleware in session layer

## Immediate User Action (Before PRs)

```bash
# 1. Start compression proxy as daemon
cd /path/to/adal-compress && node bin/adal-compress-desktop.mjs --daemon

# 2. Add to shell profile
echo 'export ADAL_APP_URL=http://localhost:PORT' >> ~/.zshrc

# 3. Restart Desktop — it will now route through proxy

# 4. Pre-compress instruction files
node bin/compress-memory.mjs --global
```

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Over-compression loses context | Protected patterns for code/paths/URLs |
| Proxy adds latency | Negligible (<5ms) — it's localhost |
| Proxy crash = broken Desktop | Graceful fallback: if proxy unreachable, requests go direct |
| Desktop doesn't inherit shell env | Document: must restart Desktop after profile change |

## Success Metrics

- Token usage per session drops 30-60%
- No regression in task completion quality
- Desktop sidecar successfully routes through proxy
- User can verify savings via `--stats` or PID file
