#!/usr/bin/env node

/**
 * adal-compress — Launch AdaL CLI with transparent token compression
 *
 * Zero-config: just run `adal-compress` instead of `adal`.
 * All your auth, credits, and model selection work exactly the same.
 * The only difference: messages get compressed before hitting the API,
 * so your credits last 30-70% longer.
 *
 * Architecture:
 *   adal-compress starts a local proxy → sets ADAL_APP_URL → launches adal
 *   AdaL thinks it's talking to adal.sylph.ai, but actually hits our proxy first.
 *   We compress, then forward to the real adal.sylph.ai with auth intact.
 */

import { spawn } from "node:child_process";
import { createProxy, getStats } from "../src/proxy.mjs";

const PROXY_PORT = 19876;
const VERSION = "1.0.0";

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { verbose: false, statsInterval: 0, adalArgs: [] };

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--") {
      config.adalArgs = args.slice(i + 1);
      break;
    } else if (args[i] === "--verbose" || args[i] === "-v") {
      config.verbose = true;
      i++;
    } else if (args[i] === "--stats" && args[i + 1]) {
      config.statsInterval = parseInt(args[i + 1]) * 1000;
      i += 2;
    } else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    } else if (args[i] === "--version") {
      console.log(VERSION);
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
  ⚡ adal-compress v${VERSION} — Token compression for AdaL CLI

  Usage:
    adal-compress                    Launch AdaL with compression enabled
    adal-compress -v                 Verbose mode (show compression stats per request)
    adal-compress --stats 30         Print savings summary every 30 seconds
    adal-compress -- --yolo          Pass flags to adal

  How it works:
    Transparently compresses messages before they reach adal.sylph.ai.
    Your auth, credits, model selection — everything works the same.
    The only difference: your credits last 30-70% longer.

  What gets compressed:
    • Natural language filler (articles, hedging, verbose phrases)
    • Tool outputs (git diff, npm install, test results, file listings)
    • Whitespace and redundant formatting

  What's preserved:
    • Code blocks, URLs, file paths, JSON
    • Technical identifiers and function signatures
    • Numbers, constraints, and semantic content
    • All assistant responses (never touched)

  Environment:
    ADAL_COMPRESS_VERBOSE=1     Enable verbose logging
    ADAL_COMPRESS_DISABLED=1    Disable compression (passthrough mode)
`);
}

async function main() {
  const config = parseArgs();
  const verbose = config.verbose || process.env.ADAL_COMPRESS_VERBOSE === "1";
  const disabled = process.env.ADAL_COMPRESS_DISABLED === "1";

  console.log(`⚡ adal-compress v${VERSION}`);

  if (disabled) {
    console.log("   ⚠️  Compression disabled (ADAL_COMPRESS_DISABLED=1)");
    console.log("   🚀 Starting AdaL CLI (passthrough)...\n");
    const adalProcess = spawn("adal", config.adalArgs, {
      stdio: "inherit",
      shell: false,
    });
    adalProcess.on("exit", (code) => process.exit(code || 0));
    return;
  }

  // Start compression proxy
  let proxy;
  try {
    proxy = createProxy(PROXY_PORT, { verbose });
    console.log(`   ✅ Compression proxy active (port ${PROXY_PORT})`);
  } catch (e) {
    console.error(`   ❌ Failed to start proxy: ${e.message}`);
    console.error("   Falling back to normal adal...\n");
    const adalProcess = spawn("adal", config.adalArgs, {
      stdio: "inherit",
      shell: false,
    });
    adalProcess.on("exit", (code) => process.exit(code || 0));
    return;
  }

  // Stats printer
  let statsTimer;
  if (config.statsInterval > 0) {
    statsTimer = setInterval(() => {
      const s = getStats();
      if (s.compressedRequests > 0) {
        console.log(
          `\n  📊 Savings: ${s.savedTokens.toLocaleString()} tokens saved (${s.savingsPct}%) across ${s.compressedRequests} requests\n`
        );
      }
    }, config.statsInterval);
  }

  console.log("   🚀 Starting AdaL CLI...\n");

  // Launch AdaL with ADAL_APP_URL pointing to our proxy
  const env = {
    ...process.env,
    ADAL_APP_URL: `http://localhost:${PROXY_PORT}`,
  };

  const adalProcess = spawn("adal", config.adalArgs, {
    env,
    stdio: "inherit",
    shell: false,
  });

  adalProcess.on("error", (err) => {
    console.error(`\n❌ Failed to start adal: ${err.message}`);
    console.error("   Is adal installed? Run: npm install -g @sylphai/adal-cli");
    cleanup(proxy, statsTimer);
    process.exit(1);
  });

  adalProcess.on("exit", (code) => {
    // Print final stats
    const s = getStats();
    if (s.compressedRequests > 0) {
      console.log(`\n  📊 Session summary:`);
      console.log(`     Requests compressed: ${s.compressedRequests}/${s.totalRequests}`);
      console.log(`     Tokens saved: ${s.savedTokens.toLocaleString()} (${s.savingsPct}%)`);
      console.log(`     Original: ~${s.originalTokens.toLocaleString()} tokens`);
      console.log(`     Sent: ~${s.compressedTokens.toLocaleString()} tokens`);
    }
    cleanup(proxy, statsTimer);
    process.exit(code || 0);
  });

  // Graceful shutdown
  const shutdown = () => {
    adalProcess.kill("SIGINT");
    setTimeout(() => cleanup(proxy, statsTimer), 2000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function cleanup(proxy, timer) {
  if (timer) clearInterval(timer);
  if (proxy) {
    try { proxy.close(); } catch {}
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
