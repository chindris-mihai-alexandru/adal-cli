/**
 * Transparent compression proxy for AdaL CLI
 *
 * Sits between AdaL's local Python backend and adal.sylph.ai.
 * Intercepts outgoing LLM requests, compresses message content,
 * then forwards to the real backend with auth headers intact.
 *
 * Architecture:
 *   AdaL Backend (port 41230-41280) → this proxy → adal.sylph.ai
 *
 * How it works:
 *   1. Launcher sets ADAL_APP_URL=http://localhost:{PROXY_PORT}
 *   2. AdaL's backend sends LLM requests to our proxy instead of adal.sylph.ai
 *   3. We parse the request body, compress messages, forward to real endpoint
 *   4. Response streams back untouched
 *
 * What gets compressed:
 *   - POST bodies containing "messages" arrays (chat completions)
 *   - Tool output content in user messages
 *   - Natural language filler in context
 *
 * What passes through untouched:
 *   - Auth headers (token, session)
 *   - All non-chat requests (auth, models, billing)
 *   - Streaming responses
 *   - Assistant messages
 */

import { createServer } from "node:http";
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";
import {
  compressMessages,
  compressProse,
  compressToolSchemas,
  compressWithAging,
  deduplicateMessages,
  estimateSavings,
  getContentTriad,
  isToolOutputContent,
  simpleHash,
} from "./compression.mjs";

let REAL_BACKEND = "https://adal.sylph.ai";
const COMPRESSIBLE_PATHS = [
  "/v1/chat/completions",
  "/v1/messages",
  "/api/chat",
  "/api/v1/chat",
];

// Auth/browser paths that must go directly to the real domain (not proxied)
const AUTH_REDIRECT_PATHS = [
  "/sign-up",
  "/sign-in",
  "/auth/",
  "/sso-callback",
  "/oauth",
];

// Cross-request content deduplication cache
const recentContentHashes = new Map(); // hash → { firstLine, ts }
const MAX_CACHE_SIZE = 30;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function evictStaleHashes() {
  const now = Date.now();
  for (const [hash, entry] of recentContentHashes) {
    if (now - entry.ts > CACHE_TTL_MS) {
      recentContentHashes.delete(hash);
    }
  }
  // If still over max, evict oldest
  if (recentContentHashes.size > MAX_CACHE_SIZE) {
    const sorted = [...recentContentHashes.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toRemove = sorted.slice(0, recentContentHashes.size - MAX_CACHE_SIZE);
    for (const [hash] of toRemove) recentContentHashes.delete(hash);
  }
}

/**
 * Cross-request deduplication for tool result content.
 * If the same tool output appeared in a recent request, replace with a short reference.
 */
function deduplicateToolResults(messages) {
  if (!Array.isArray(messages)) return messages;

  return messages.map((msg) => {
    if (!msg || !msg.content || msg.role === "assistant") return msg;

    // Only dedup tool results and user messages with substantial content
    if (msg.role !== "tool" && msg.role !== "user") return msg;

    const content = typeof msg.content === "string" ? msg.content : null;
    if (!content || content.length < 200) return msg;

    const hash = simpleHash(content);

    if (recentContentHashes.has(hash)) {
      const cached = recentContentHashes.get(hash);
      // Guard against hash collisions: verify content length matches
      if (Math.abs(cached.len - content.length) < 5) {
        cached.ts = Date.now();
        // Triadic symbolic reference — compact + semantically dense
        return { ...msg, content: `[§ ${cached.triad} ${cached.label}, ${cached.len} chars, seen earlier]` };
      }
    }

    // Store in cache with triadic signature
    const { triad, label } = getContentTriad(content);
    recentContentHashes.set(hash, {
      triad,
      label,
      len: content.length,
      ts: Date.now(),
    });
    evictStaleHashes();

    return msg;
  });
}

// Stats tracking
let stats = {
  totalRequests: 0,
  compressedRequests: 0,
  originalTokens: 0,
  compressedTokens: 0,
  startTime: Date.now(),
  savingsByType: {
    prose: 0,
    toolOutput: 0,
    schemas: 0,
    aging: 0,
    dedup: 0,
  },
};

export function getStats() {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const savedTokens = stats.originalTokens - stats.compressedTokens;
  const savingsPct = stats.originalTokens > 0
    ? ((savedTokens / stats.originalTokens) * 100).toFixed(1)
    : "0.0";
  return { ...stats, savingsByType: { ...stats.savingsByType }, savedTokens, savingsPct, elapsedSeconds: elapsed };
}

export function resetStats() {
  stats = {
    totalRequests: 0,
    compressedRequests: 0,
    originalTokens: 0,
    compressedTokens: 0,
    startTime: Date.now(),
    savingsByType: {
      prose: 0,
      toolOutput: 0,
      schemas: 0,
      aging: 0,
      dedup: 0,
    },
  };
}

/**
 * Determine if a request path contains compressible LLM messages.
 */
function isCompressiblePath(path) {
  return COMPRESSIBLE_PATHS.some((p) => path.includes(p));
}

/**
 * Compress the request body if it contains messages.
 * Returns { body, compressed, savings }
 */
function compressRequestBody(bodyStr) {
  try {
    const body = JSON.parse(bodyStr);

    // Compress tool schemas if present
    if (body.tools && Array.isArray(body.tools)) {
      const preSchemaJson = JSON.stringify(body.tools);
      body.tools = compressToolSchemas(body.tools);
      const postSchemaJson = JSON.stringify(body.tools);
      stats.savingsByType.schemas += Math.ceil((preSchemaJson.length - postSchemaJson.length) / 4);
    }

    // Anthropic Messages API format
    if (body.messages && Array.isArray(body.messages)) {
      const originalJson = JSON.stringify(body.messages);

      // Snapshot per-message metadata for granular stats attribution
      const msgMeta = body.messages.map(m => {
        const content = typeof m.content === "string" ? m.content : "";
        return {
          len: content.length,
          isToolOutput: content.length >= 100 && isToolOutputContent(content),
          role: m.role,
        };
      });

      // Cross-request deduplication FIRST (on original content, before compression)
      // This catches duplicates even for content that would compress below threshold
      body.messages = deduplicateToolResults(body.messages);
      const postDedupJson = JSON.stringify(body.messages);

      // Apply progressive aging based on message count OR total token pressure
      const totalChars = body.messages.reduce((sum, m) => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
        return sum + (content?.length || 0);
      }, 0);
      const estimatedTokens = Math.ceil(totalChars / 4);
      const shouldAge = body.messages.length > 8 || estimatedTokens > 12000;

      if (shouldAge) {
        const recentCount = body.messages.length > 20 ? 8 : 6;
        body.messages = compressWithAging(body.messages, { recentCount });
      } else {
        body.messages = compressMessages(body.messages);
      }

      // Deduplicate repeated system prompts (intra-request)
      body.messages = deduplicateMessages(body.messages);

      const compressedJson = JSON.stringify(body.messages);

      // Calculate per-category savings with granular attribution
      const dedupSaved = Math.ceil((originalJson.length - postDedupJson.length) / 4);
      stats.savingsByType.dedup += dedupSaved;

      // Attribute compression savings per-message type
      // Skip messages that were already deduped (their savings are in dedupSaved)
      const compressionSaved = Math.ceil((postDedupJson.length - compressedJson.length) / 4);
      let toolSavings = 0;
      body.messages.forEach((m, i) => {
        if (i >= msgMeta.length) return;
        // Skip deduped messages — their savings already counted in dedupSaved
        if (typeof m.content === "string" && (m.content.startsWith("[§ ") || m.content.startsWith("[repeated content"))) return;
        if (!msgMeta[i].isToolOutput || !m.content) return;
        const newLen = typeof m.content === "string" ? m.content.length : 0;
        const saved = Math.ceil((msgMeta[i].len - newLen) / 4);
        if (saved > 0) toolSavings += saved;
      });
      stats.savingsByType.toolOutput += Math.min(toolSavings, compressionSaved);
      if (shouldAge) {
        stats.savingsByType.aging += Math.max(0, compressionSaved - toolSavings);
      } else {
        stats.savingsByType.prose += Math.max(0, compressionSaved - toolSavings);
      }

      // Use full body for overall savings (includes schema compression too)
      const finalBody = JSON.stringify(body);
      const savings = estimateSavings(bodyStr, finalBody);
      return {
        body: finalBody,
        compressed: true,
        savings,
      };
    }

    // Sometimes content is at top level (single message)
    if (body.content && typeof body.content === "string" && body.content.length > 100) {
      const originalContent = body.content;
      body.content = compressProse(body.content);
      const savings = estimateSavings(originalContent, body.content);
      return {
        body: JSON.stringify(body),
        compressed: true,
        savings,
      };
    }

    // If tools were compressed but no messages/content matched, still return modified body
    if (body.tools && Array.isArray(body.tools)) {
      return { body: JSON.stringify(body), compressed: true, savings: { origTokens: 0, compTokens: 0, saved: 0, pct: "0.0" } };
    }

    return { body: bodyStr, compressed: false, savings: null };
  } catch {
    // Not JSON or parse error — pass through
    return { body: bodyStr, compressed: false, savings: null };
  }
}

/**
 * Forward a request to the real AdaL backend (adal.sylph.ai).
 */
function forwardRequest(req, body, res) {
  const targetUrl = new URL(req.url, REAL_BACKEND);
  const isHttps = targetUrl.protocol === "https:";
  const transport = isHttps ? https : http;

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isHttps ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: {
      ...req.headers,
      host: targetUrl.host,
      "content-length": Buffer.byteLength(body),
    },
  };

  // Remove headers that are stale after body rewrite or proxy-specific
  delete options.headers["connection"];
  delete options.headers["accept-encoding"];
  delete options.headers["transfer-encoding"];

  const proxyReq = transport.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (e) => {
    console.error(`  ⚠️  Forward error: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(`Proxy error: ${e.message}`);
    }
  });

  proxyReq.write(body);
  proxyReq.end();
}

/**
 * Create and start the compression proxy server.
 */
export function createProxy(port, options = {}) {
  const { verbose = false, realBackendUrl = REAL_BACKEND } = options;

  // Override module-level backend URL for this proxy instance
  REAL_BACKEND = realBackendUrl;

  const server = createServer(async (req, res) => {
    // Health check endpoint for port conflict detection
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "adal-compress", pid: process.pid }));
      return;
    }

    stats.totalRequests++;

    // Auth/browser requests: redirect to real domain (Clerk needs real origin)
    const isAuthPath = AUTH_REDIRECT_PATHS.some((p) => req.url.includes(p));
    if (isAuthPath) {
      const realUrl = new URL(req.url, REAL_BACKEND);
      if (verbose) {
        console.log(`  🔑 Auth redirect: ${req.url} → ${realUrl.href}`);
      }
      res.writeHead(302, { Location: realUrl.href });
      res.end();
      return;
    }

    // Collect request body
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString();

      // Check if this is a compressible LLM request
      if (req.method === "POST" && isCompressiblePath(req.url) && rawBody.length > 0) {
        const { body, compressed, savings } = compressRequestBody(rawBody);

        if (compressed && savings) {
          stats.compressedRequests++;
          stats.originalTokens += savings.origTokens;
          stats.compressedTokens += savings.compTokens;

          if (verbose) {
            console.log(
              `  📦 Compressed: ${savings.origTokens}→${savings.compTokens} tokens (-${savings.pct}%) [${req.url}]`
            );
          }
        }

        forwardRequest(req, body, res);
      } else {
        // Pass through non-compressible requests unchanged
        forwardRequest(req, rawBody, res);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const assignedPort = server.address().port;
      if (verbose) {
        console.log(`   ✅ Compression proxy on :${assignedPort} → ${realBackendUrl}`);
      }
      resolve({ server, port: assignedPort });
    });
  });
}
