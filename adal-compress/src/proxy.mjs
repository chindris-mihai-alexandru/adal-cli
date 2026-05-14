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

// Stats tracking
let stats = {
  totalRequests: 0,
  compressedRequests: 0,
  originalTokens: 0,
  compressedTokens: 0,
  startTime: Date.now(),
};

export function getStats() {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const savedTokens = stats.originalTokens - stats.compressedTokens;
  const savingsPct = stats.originalTokens > 0
    ? ((savedTokens / stats.originalTokens) * 100).toFixed(1)
    : "0.0";
  return { ...stats, savedTokens, savingsPct, elapsedSeconds: elapsed };
}

export function resetStats() {
  stats = {
    totalRequests: 0,
    compressedRequests: 0,
    originalTokens: 0,
    compressedTokens: 0,
    startTime: Date.now(),
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
      body.tools = compressToolSchemas(body.tools);
    }

    // Anthropic Messages API format
    if (body.messages && Array.isArray(body.messages)) {
      const originalJson = JSON.stringify(body.messages);

      // Apply progressive aging for long conversations
      if (body.messages.length > 8) {
        body.messages = compressWithAging(body.messages);
      } else {
        body.messages = compressMessages(body.messages);
      }

      // Deduplicate repeated system prompts
      body.messages = deduplicateMessages(body.messages);

      const compressedJson = JSON.stringify(body.messages);
      const savings = estimateSavings(originalJson, compressedJson);
      return {
        body: JSON.stringify(body),
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
