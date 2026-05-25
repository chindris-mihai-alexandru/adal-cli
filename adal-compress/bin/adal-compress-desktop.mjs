#!/usr/bin/env node

/**
 * adal-compress-desktop — Launch AdaL Desktop with compression proxy
 *
 * The Desktop app spawns a sidecar (opencode CLI) that talks to providers.
 * This script starts the compression proxy and sets ADAL_APP_URL so the
 * Desktop's sidecar routes through it automatically.
 *
 * Usage:
 *   adal-compress-desktop              Start proxy, then launch Desktop
 *   adal-compress-desktop --daemon     Start proxy in background (for manual Desktop launch)
 *   adal-compress-desktop --port 9999  Use specific port
 *
 * How it works:
 *   1. Starts compression proxy on a local port
 *   2. Sets ADAL_APP_URL in the environment
 *   3. Either launches Desktop app OR runs as daemon for existing Desktop
 *
 * For Desktop to pick up the proxy:
 *   Option A: Launch Desktop via this script (inherits env)
 *   Option B: Set ADAL_APP_URL globally in shell profile, restart Desktop
 *   Option C: Use Desktop's "Custom Server URL" setting (Settings → Server URL)
 */

import { createProxy, getStats } from "../src/proxy.mjs";
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const VERSION = "1.0.0";

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    verbose: false,
    daemon: false,
    port: 0,
    launchDesktop: true,
    statsInterval: 0,
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--verbose":
      case "-v":
        config.verbose = true;
        i++;
        break;
      case "--daemon":
      case "-d":
        config.daemon = true;
        config.launchDesktop = false;
        i++;
        break;
      case "--port":
        config.port = parseInt(args[i + 1]) || 0;
        i += 2;
        break;
      case "--stats":
        config.statsInterval = (parseInt(args[i + 1]) || 30) * 1000;
        i += 2;
        break;
      case "--no-launch":
        config.launchDesktop = false;
        i++;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      case "--version":
        console.log(VERSION);
        process.exit(0);
      default:
        i++;
    }
  }
  return config;
}

function printHelp() {
  console.log(`
  ⚡ adal-compress-desktop v${VERSION} — Token compression for AdaL Desktop

  Usage:
    adal-compress-desktop                  Launch Desktop with compression
    adal-compress-desktop --daemon         Run proxy only (background mode)
    adal-compress-desktop --port 9999      Use specific port
    adal-compress-desktop --no-launch      Start proxy, print env, don't launch app

  Integration methods (pick one):

    Method 1 — Launch via this script:
      $ adal-compress-desktop
      Desktop inherits ADAL_APP_URL automatically.

    Method 2 — Shell profile (always-on):
      Add to ~/.zshrc or ~/.bashrc:
        export ADAL_APP_URL=http://localhost:YOUR_PORT
      Then restart Desktop.

    Method 3 — Desktop Custom Server URL:
      Desktop Settings → Server URL → set to proxy address.
      Note: This changes where Desktop connects, not the sidecar's upstream.

    Method 4 — Daemon mode (recommended for power users):
      $ adal-compress-desktop --daemon
      Proxy runs in background. Set ADAL_APP_URL in shell profile.
      All AdaL instances (CLI + Desktop) route through proxy.

  Environment:
    ADAL_COMPRESS_VERBOSE=1     Enable verbose logging
    ADAL_COMPRESS_DISABLED=1    Disable compression (passthrough mode)
`);
}

function getDesktopAppPath() {
  if (process.platform === "darwin") {
    const paths = [
      "/Applications/AdaL.app",
      "/Applications/OpenCode.app",
      path.join(os.homedir(), "Applications/AdaL.app"),
      path.join(os.homedir(), "Applications/OpenCode.app"),
    ];
    return paths.find((p) => existsSync(p));
  }
  // Linux: try common locations
  if (process.platform === "linux") {
    try {
      return execSync("which adal-desktop 2>/dev/null || which opencode-desktop 2>/dev/null")
        .toString()
        .trim();
    } catch {
      return null;
    }
  }
  return null;
}

function writePidFile(port) {
  const pidDir = path.join(os.homedir(), ".adal");
  if (!existsSync(pidDir)) mkdirSync(pidDir, { recursive: true });

  const pidFile = path.join(pidDir, "compress-proxy.json");
  writeFileSync(
    pidFile,
    JSON.stringify({
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
      url: `http://localhost:${port}`,
    })
  );
  return pidFile;
}

async function main() {
  const config = parseArgs();
  const verbose = config.verbose || process.env.ADAL_COMPRESS_VERBOSE === "1";
  const disabled = process.env.ADAL_COMPRESS_DISABLED === "1";

  console.log(`⚡ adal-compress-desktop v${VERSION}`);

  if (disabled) {
    console.log("   ⚠️  Compression disabled (ADAL_COMPRESS_DISABLED=1)");
    if (config.launchDesktop) launchDesktop({});
    return;
  }

  // Start compression proxy (with port conflict handling)
  let proxy, assignedPort;
  try {
    const result = await createProxy(config.port, { verbose });
    proxy = result.server;
    assignedPort = result.port;
    console.log(`   ✅ Compression proxy active (port ${assignedPort})`);
    console.log(`   📍 ADAL_APP_URL=http://localhost:${assignedPort}`);
  } catch (e) {
    if (e.code === "EADDRINUSE" && config.port !== 0) {
      // Port already in use — check if it's already our proxy
      console.log(`   ℹ️  Port ${config.port} already in use.`);
      try {
        const res = await fetch(`http://localhost:${config.port}/health`).catch(() => null);
        if (res) {
          console.log(`   ✅ Existing proxy detected on port ${config.port} — reusing.`);
          assignedPort = config.port;
          // Skip starting a new proxy, just write PID file and continue
        } else {
          // Port taken by something else — fall back to random port
          console.log(`   ⚠️  Port taken by another process. Trying random port...`);
          const result = await createProxy(0, { verbose });
          proxy = result.server;
          assignedPort = result.port;
          console.log(`   ✅ Compression proxy active (port ${assignedPort})`);
          console.log(`   📍 ADAL_APP_URL=http://localhost:${assignedPort}`);
        }
      } catch {
        console.error(`   ❌ Failed to start proxy: ${e.message}`);
        process.exit(1);
      }
    } else {
      console.error(`   ❌ Failed to start proxy: ${e.message}`);
      process.exit(1);
    }
  }

  // Write PID file for other tools to discover
  const pidFile = writePidFile(assignedPort);
  console.log(`   📄 PID file: ${pidFile}`);

  // Stats printer
  if (config.statsInterval > 0) {
    setInterval(() => {
      const s = getStats();
      if (s.compressedRequests > 0) {
        console.log(
          `\n  📊 Savings: ${s.savedTokens.toLocaleString()} tokens saved (${s.savingsPct}%) across ${s.compressedRequests} requests\n`
        );
      }
    }, config.statsInterval);
  }

  if (config.daemon) {
    console.log(`\n   🔄 Daemon mode — proxy running in foreground.`);
    console.log(`   💡 Set in your shell profile:`);
    console.log(`      export ADAL_APP_URL=http://localhost:${assignedPort}`);
    console.log(`\n   Press Ctrl+C to stop.\n`);

    process.on("SIGINT", () => {
      const s = getStats();
      if (s.compressedRequests > 0) {
        console.log(`\n  📊 Session: ${s.savedTokens.toLocaleString()} tokens saved (${s.savingsPct}%)`);
      }
      process.exit(0);
    });
    return;
  }

  if (config.launchDesktop) {
    launchDesktop({ ADAL_APP_URL: `http://localhost:${assignedPort}` });
  } else {
    console.log(`\n   💡 Proxy ready. Export this in your shell:`);
    console.log(`      export ADAL_APP_URL=http://localhost:${assignedPort}\n`);
  }
}

function launchDesktop(extraEnv) {
  const appPath = getDesktopAppPath();
  if (!appPath) {
    console.log(`\n   ⚠️  Desktop app not found. Set ADAL_APP_URL manually:`);
    console.log(`      export ADAL_APP_URL=${extraEnv.ADAL_APP_URL || "http://localhost:PORT"}`);
    return;
  }

  console.log(`   🚀 Launching Desktop: ${appPath}`);

  const env = { ...process.env, ...extraEnv };

  if (process.platform === "darwin") {
    spawn("open", ["-a", appPath], { env, detached: true, stdio: "ignore" }).unref();
  } else {
    spawn(appPath, [], { env, detached: true, stdio: "ignore" }).unref();
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
