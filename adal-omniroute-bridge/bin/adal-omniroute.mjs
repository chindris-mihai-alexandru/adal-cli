#!/usr/bin/env node

/**
 * adal-omniroute — Launch AdaL CLI routed through OmniRoute
 *
 * This script:
 * 1. Verifies OmniRoute is running
 * 2. Sets SDK env vars (ANTHROPIC_BASE_URL, OPENAI_BASE_URL, etc.)
 * 3. Starts a local HTTP reverse-proxy that rewrites provider URLs to OmniRoute
 * 4. Launches AdaL CLI with the modified environment
 *
 * Strategy (belt + suspenders):
 *   - ENV vars: ANTHROPIC_BASE_URL, OPENAI_BASE_URL (SDK-native, works if respected)
 *   - HTTP_PROXY/HTTPS_PROXY: Catches requests at transport level (aiohttp respects these)
 *   - NO_PROXY excludes AdaL's own backend (adal.sylph.ai, localhost)
 *
 * Usage:
 *   adal-omniroute                    # Start with default OmniRoute at localhost:20128
 *   adal-omniroute --port 20128       # Custom OmniRoute port
 *   adal-omniroute --omniroute-url http://remote:20128  # Remote OmniRoute
 *   adal-omniroute --no-proxy         # Skip HTTP_PROXY, env vars only
 *   adal-omniroute -- --yolo          # Pass flags to adal after --
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import http from "node:http";
import { URL } from "node:url";

// --- Configuration ---
const DEFAULT_OMNIROUTE_URL = "http://localhost:20128";
const INTERCEPT_PROXY_PORT = 18199;

const PROVIDER_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
];

// --- Argument parsing ---
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    omnirouteUrl: DEFAULT_OMNIROUTE_URL,
    useProxy: true,
    adalArgs: [],
  };

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--") {
      config.adalArgs = args.slice(i + 1);
      break;
    } else if (args[i] === "--port" && args[i + 1]) {
      config.omnirouteUrl = `http://localhost:${args[i + 1]}`;
      i += 2;
    } else if (args[i] === "--omniroute-url" && args[i + 1]) {
      config.omnirouteUrl = args[i + 1];
      i += 2;
    } else if (args[i] === "--no-proxy") {
      config.useProxy = false;
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    } else {
      config.adalArgs.push(args[i]);
      i++;
    }
  }
  return config;
}

function printHelp() {
  console.log(`
  ⚡ adal-omniroute — Route AdaL CLI through OmniRoute

  Usage:
    adal-omniroute                              Start with defaults
    adal-omniroute --port 20128                 Custom OmniRoute port
    adal-omniroute --omniroute-url <url>        Remote OmniRoute instance
    adal-omniroute --no-proxy                   Env vars only (no intercept proxy)
    adal-omniroute -- [adal flags]              Pass flags to adal

  Environment Variables (override defaults):
    OMNIROUTE_URL        OmniRoute base URL (default: http://localhost:20128)
    OMNIROUTE_API_KEY    API key for OmniRoute (used as provider key)

  How it works:
    Layer 1: Sets ANTHROPIC_BASE_URL, OPENAI_BASE_URL (SDK env vars)
    Layer 2: Sets HTTP_PROXY/HTTPS_PROXY pointing to local intercept proxy
    Layer 3: Intercept proxy rewrites provider CONNECT tunnels to OmniRoute

    If Layer 1 works (SDK respects env vars), great — direct routing.
    If not, Layer 2+3 catch the requests at transport level.
`);
}

// --- Health check ---
async function checkOmniRoute(url) {
  return new Promise((resolve) => {
    const req = http.get(`${url}/v1/models`, { timeout: 3000 }, (res) => {
      resolve(res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

// --- Intercept Proxy ---
// HTTP forward proxy that intercepts CONNECT tunnels to provider hosts
// and redirects them to OmniRoute's HTTP endpoint instead.
function startInterceptProxy(omnirouteUrl) {
  const omniUrl = new URL(omnirouteUrl);
  const omniHost = omniUrl.hostname;
  const omniPort = parseInt(omniUrl.port) || 80;

  const server = createServer((req, res) => {
    // Plain HTTP requests — forward to OmniRoute
    const options = {
      hostname: omniHost,
      port: omniPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: omniUrl.host },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (e) => {
      res.writeHead(502);
      res.end(`Bridge error: ${e.message}`);
    });

    req.pipe(proxyReq);
  });

  // CONNECT method — HTTPS tunnel interception
  server.on("connect", (req, clientSocket, head) => {
    const [hostname] = req.url.split(":");
    const isProvider = PROVIDER_HOSTS.some((h) => hostname.includes(h));

    if (isProvider) {
      // Redirect to OmniRoute — connect to its HTTP port
      const serverSocket = net.connect(omniPort, omniHost, () => {
        clientSocket.write(
          "HTTP/1.1 200 Connection Established\r\n\r\n"
        );
        if (head.length > 0) serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
      });
      serverSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => serverSocket.destroy());
    } else {
      // Non-provider: pass through to actual destination
      const [host, port] = req.url.split(":");
      const serverSocket = net.connect(
        parseInt(port) || 443,
        host,
        () => {
          clientSocket.write(
            "HTTP/1.1 200 Connection Established\r\n\r\n"
          );
          if (head.length > 0) serverSocket.write(head);
          serverSocket.pipe(clientSocket);
          clientSocket.pipe(serverSocket);
        }
      );
      serverSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => serverSocket.destroy());
    }
  });

  server.listen(INTERCEPT_PROXY_PORT, "127.0.0.1");
  return server;
}

// --- Main ---
async function main() {
  const config = parseArgs();
  const omnirouteUrl = process.env.OMNIROUTE_URL || config.omnirouteUrl;
  const omnirouteKey = process.env.OMNIROUTE_API_KEY || "";

  console.log("⚡ adal-omniroute bridge v1.0.0");
  console.log(`   OmniRoute: ${omnirouteUrl}`);

  // Check OmniRoute health
  const healthy = await checkOmniRoute(omnirouteUrl);
  if (!healthy) {
    console.error("❌ OmniRoute is not responding. Start it first: omniroute");
    console.error(`   Tried: ${omnirouteUrl}/v1/models`);
    process.exit(1);
  }
  console.log("   ✅ OmniRoute is running");

  // Build environment for AdaL
  const env = {
    ...process.env,
    // Layer 1: SDK-level env vars
    ANTHROPIC_BASE_URL: omnirouteUrl,
    OPENAI_BASE_URL: `${omnirouteUrl}/v1`,
    GOOGLE_BASE_URL: `${omnirouteUrl}/v1`,
    // Override keys if OmniRoute key provided
    ...(omnirouteKey && {
      ANTHROPIC_API_KEY: omnirouteKey,
      OPENAI_API_KEY: omnirouteKey,
      GOOGLE_API_KEY: omnirouteKey,
    }),
  };

  // Layer 2+3: Start intercept proxy
  let proxy;
  if (config.useProxy) {
    try {
      proxy = startInterceptProxy(omnirouteUrl);
      console.log(`   ✅ Intercept proxy on :${INTERCEPT_PROXY_PORT}`);
      env.HTTP_PROXY = `http://127.0.0.1:${INTERCEPT_PROXY_PORT}`;
      env.HTTPS_PROXY = `http://127.0.0.1:${INTERCEPT_PROXY_PORT}`;
      env.http_proxy = env.HTTP_PROXY;
      env.https_proxy = env.HTTPS_PROXY;
      // Don't intercept AdaL's own backend or local services
      env.NO_PROXY = "localhost,127.0.0.1,adal.sylph.ai,*.sylph.ai";
      env.no_proxy = env.NO_PROXY;
    } catch (e) {
      console.warn(`   ⚠️  Proxy failed: ${e.message} (continuing with env vars only)`);
    }
  } else {
    console.log("   ℹ️  Proxy disabled (--no-proxy)");
  }

  console.log("   🚀 Starting AdaL CLI...\n");

  // Launch AdaL CLI
  const adalProcess = spawn("adal", config.adalArgs, {
    env,
    stdio: "inherit",
    shell: false,
  });

  adalProcess.on("error", (err) => {
    console.error(`\n❌ Failed to start adal: ${err.message}`);
    console.error("   Is adal installed? Run: npm install -g @sylphai/adal-cli");
    cleanup(proxy);
    process.exit(1);
  });

  adalProcess.on("exit", (code) => {
    cleanup(proxy);
    process.exit(code || 0);
  });

  // Graceful shutdown
  const shutdown = () => {
    adalProcess.kill("SIGINT");
    setTimeout(() => cleanup(proxy), 1000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function cleanup(proxy) {
  if (proxy) {
    try { proxy.close(); } catch {}
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
