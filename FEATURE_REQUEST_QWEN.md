# Feature Request: Add Alibaba Cloud / Qwen Models as a Provider

## Summary

Add Alibaba Cloud's Qwen models as a first-class provider in AdaL CLI, including:
1. **BYOAK (Bring Your Own API Key)** support for DashScope API keys
2. **Qwen cloud models** in the `/model` selector (Qwen3 Coder Plus, Qwen3 Coder Flash, Qwen3.5 Plus)
3. **Partnership integration** (optional) — offer Qwen models through AdaL subscription tiers, similar to the existing ZAI/GLM partnership

## Why This Matters

### 1. Competitive Gap

AdaL currently supports cloud models from OpenAI, Anthropic, Google, ZAI, and MiniMax — but **not Alibaba Cloud / Qwen** via cloud API, despite Qwen3 Coder being one of the strongest open-weight coding models available. (AdaL does support `qwen3-coder:30b` locally via Ollama, but cloud API access to the full-sized models is missing.)

Other coding agents are already adding Alibaba Cloud support:
- **ForgeCode** (6,600+ stars) added `AlibabaCoding` as a built-in provider with Qwen3.5+, Qwen3 Coder, and more ([PR #2696](https://github.com/tailcallhq/forgecode/issues/2696))
- **Pi Coding Agent** has a working Qwen CLI extension with OAuth-based free access and full `thinkingFormat: "qwen"` support baked into the core ([PR #940](https://github.com/badlogic/pi-mono/issues/940))

### 2. Alibaba Cloud Pricing Changes Create an Opportunity

Alibaba Cloud recently removed their $3/month Lite plan, leaving only $50+/month plans. Individual developers who want occasional Qwen API access are now priced out of direct DashScope access.

**AdaL is perfectly positioned to fill this gap** — just as it already does with ZAI/GLM models. By offering Qwen through AdaL's $20–$200/month subscription tiers, users get cost-effective access to Qwen models without needing a $50 Alibaba Cloud subscription.

### 3. Strong Model Lineup

| Model | Context | Strengths |
|-------|---------|-----------|
| **Qwen3 Coder Plus** | 1M tokens | Coding-optimized, massive context window |
| **Qwen3 Coder Flash** | 1M tokens | Fast, budget coding tasks |
| **Qwen3.5 Plus** | 256K tokens | Multimodal (text + image), hybrid thinking, 119+ languages |

The 1M context window on Qwen3 Coder models matches Gemini and exceeds Claude (200K) and GPT (272K) — a real differentiator for large codebase work.

### 4. Existing Partnership Model Proves the Path

AdaL already has a successful partnership with ZhipuAI (Z.AI) offering GLM-5, GLM-4.7 FlashX, etc. as first-class models. Notably, Alibaba Cloud's DashScope platform also hosts GLM and Kimi models alongside Qwen — so a single Alibaba Cloud integration could potentially expand the model catalog further.

## Proposed Implementation

### Phase 1: BYOAK Support (Minimal Effort)

DashScope speaks the **OpenAI-compatible API** (`dashscope.aliyuncs.com/compatible-mode/v1`), so integration is straightforward:

- Add `DASHSCOPE_API_KEY` to `/byoak` alongside Anthropic, OpenAI, and Google
- Register Qwen models in the model selector under a "Qwen" or "Alibaba Cloud" provider section
- Add `enable_thinking` parameter support for Qwen's reasoning mode

### Phase 2: Subscription Integration (Partnership)

- Negotiate with Alibaba Cloud to offer Qwen models through AdaL credits (similar to ZAI partnership)
- Add Qwen models to the Recommended section in `/model`
- Include Qwen in billing/pricing documentation

### Phase 3: Free Tier via chat.qwen.ai OAuth (Optional)

Alibaba offers **free API access (2,000 requests/day)** through `chat.qwen.ai` OAuth with device code flow + PKCE — no Alibaba Cloud subscription required. This is the same model as how ChatGPT Subscription works in AdaL today, or how Google Gemini CLI provides free access with a Google account. Pi Coding Agent already confirmed this works ([issue #919](https://github.com/badlogic/pi-mono/issues/919): "Qwen CLI provides capable models for free with generous limits"). AdaL could offer this as a "Qwen Free" option in `/model` → Third Party Subscriptions.

## Technical Notes

- **API compatibility**: DashScope uses OpenAI Chat Completions format — same as what AdaL already supports
- **Thinking/reasoning**: Qwen uses a top-level `enable_thinking: true` parameter (not OpenAI's `reasoning_effort`), which needs a small adapter
- **Known issues**: ForgeCode's Alibaba integration hit 404 errors on their Anthropic-compatible endpoint ([#2781](https://github.com/tailcallhq/forgecode/issues/2781)) — recommend using the OpenAI-compatible endpoint (`/compatible-mode/v1`) instead, which is more stable
- **Prompt caching**: DashScope supports Anthropic-style `cache_control` for prompt caching (Pi is actively adding this: [#3392](https://github.com/badlogic/pi-mono/issues/3392))

## References

- [DashScope API docs](https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope)
- [Qwen3 Coder announcement](https://qwenlm.github.io/blog/qwen3-coder/)
- [chat.qwen.ai](https://chat.qwen.ai) — free consumer access with OAuth
- [Pi's Qwen CLI extension](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/custom-provider-qwen-cli) — reference implementation
- [ForgeCode AlibabaCoding provider](https://github.com/tailcallhq/forgecode/issues/2696)
- [AdaL BYOAK docs](https://docs.adal.sylph.ai/features/bring-your-own-api-key)
