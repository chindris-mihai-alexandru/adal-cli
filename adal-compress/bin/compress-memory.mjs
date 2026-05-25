#!/usr/bin/env node

/**
 * compress-memory — Compress AGENTS.md, CLAUDE.md, and other memory files
 *
 * Pre-compresses instruction/context files that get loaded every session.
 * These files eat input tokens on every single turn. Compressing them once
 * saves tokens on every future interaction.
 *
 * Usage:
 *   compress-memory                          Compress AGENTS.md in current dir
 *   compress-memory path/to/CLAUDE.md        Compress specific file
 *   compress-memory --global                 Compress ~/.config/opencode/AGENTS.md
 *   compress-memory --dry-run                Show savings without writing
 *   compress-memory --backup                 Keep .full.md backup (default: yes)
 *
 * What gets compressed:
 *   - Verbose explanations → terse bullets
 *   - Redundant phrasing → concise equivalents
 *   - Whitespace bloat → normalized
 *
 * What's preserved exactly:
 *   - Code blocks, examples, commands
 *   - File paths, URLs, config keys
 *   - YAML frontmatter
 *   - Structural headers and lists
 *   - Technical constraints and rules
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { compressProse, estimateSavings } from "../src/compression.mjs";

const VERSION = "1.0.0";

const DEFAULT_FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"];
const GLOBAL_PATHS = [
  path.join(os.homedir(), ".config", "opencode", "AGENTS.md"),
  path.join(os.homedir(), ".claude", "CLAUDE.md"),
];

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    files: [],
    global: false,
    dryRun: false,
    backup: true,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--global":
      case "-g":
        config.global = true;
        break;
      case "--dry-run":
      case "-n":
        config.dryRun = true;
        break;
      case "--no-backup":
        config.backup = false;
        break;
      case "--verbose":
      case "-v":
        config.verbose = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      case "--version":
        console.log(VERSION);
        process.exit(0);
      default:
        if (!args[i].startsWith("-")) {
          config.files.push(args[i]);
        }
    }
  }
  return config;
}

function printHelp() {
  console.log(`
  📦 compress-memory v${VERSION} — Pre-compress instruction files

  Usage:
    compress-memory                     Compress AGENTS.md/CLAUDE.md in cwd
    compress-memory FILE [FILE...]      Compress specific files
    compress-memory --global            Compress global config files
    compress-memory --dry-run           Preview savings without writing

  Options:
    --global, -g       Target global instruction files (~/.config/opencode/, ~/.claude/)
    --dry-run, -n      Show what would change without writing
    --no-backup        Don't create .full.md backup
    --verbose, -v      Show detailed compression info

  Savings are permanent — compressed files load every session.
  Original preserved as FILE.full.md (unless --no-backup).
`);
}

/**
 * Compress a memory/instruction file.
 * Preserves: YAML frontmatter, code blocks, headers, lists with code.
 * Compresses: Prose paragraphs, verbose explanations.
 */
function compressMemoryFile(content) {
  const lines = content.split("\n");
  const result = [];
  let inFrontmatter = false;
  let inCodeBlock = false;
  let frontmatterCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track YAML frontmatter
    if (line.trim() === "---") {
      frontmatterCount++;
      if (frontmatterCount <= 2) {
        inFrontmatter = frontmatterCount === 1;
        result.push(line);
        continue;
      }
    }

    // Pass frontmatter through unchanged
    if (inFrontmatter) {
      result.push(line);
      continue;
    }

    // Track code blocks
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    // Pass code blocks through unchanged
    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    // Pass headers through unchanged
    if (line.startsWith("#")) {
      result.push(line);
      continue;
    }

    // Pass list items with code/paths through unchanged
    if (/^[\s]*[-*]\s/.test(line) && /[`\/\\]/.test(line)) {
      result.push(line);
      continue;
    }

    // Pass empty lines through
    if (line.trim() === "") {
      result.push(line);
      continue;
    }

    // Compress prose lines
    const compressed = compressProse(line);
    result.push(compressed);
  }

  // Final whitespace normalization
  return result.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function processFile(filePath, config) {
  if (!existsSync(filePath)) {
    if (config.verbose) console.log(`   ⏭  Skip (not found): ${filePath}`);
    return null;
  }

  const original = readFileSync(filePath, "utf-8");
  const compressed = compressMemoryFile(original);
  const savings = estimateSavings(original, compressed);

  const basename = path.basename(filePath);
  const pctNum = parseFloat(savings.pct);

  if (pctNum < 5) {
    console.log(`   ⏭  ${basename}: already compact (${savings.pct}% reduction)`);
    return null;
  }

  if (config.dryRun) {
    console.log(`   📊 ${basename}: ${savings.origTokens}→${savings.compTokens} tok (-${savings.pct}%)`);
    if (config.verbose) {
      // Show first few changed lines
      const origLines = original.split("\n");
      const compLines = compressed.split("\n");
      let shown = 0;
      for (let i = 0; i < Math.min(origLines.length, compLines.length) && shown < 3; i++) {
        if (origLines[i] !== compLines[i] && origLines[i].trim()) {
          console.log(`       - ${origLines[i].slice(0, 80)}`);
          console.log(`       + ${compLines[i].slice(0, 80)}`);
          shown++;
        }
      }
    }
    return savings;
  }

  // Backup original
  if (config.backup) {
    const ext = path.extname(filePath);
    const backupPath = filePath.replace(ext, `.full${ext}`);
    if (!existsSync(backupPath)) {
      copyFileSync(filePath, backupPath);
      console.log(`   💾 Backup: ${path.basename(backupPath)}`);
    }
  }

  // Write compressed
  writeFileSync(filePath, compressed);
  console.log(`   ✅ ${basename}: ${savings.origTokens}→${savings.compTokens} tok (-${savings.pct}%)`);

  return savings;
}

function main() {
  const config = parseArgs();

  console.log(`📦 compress-memory v${VERSION}${config.dryRun ? " (dry run)" : ""}\n`);

  let files = config.files;

  if (files.length === 0) {
    if (config.global) {
      files = GLOBAL_PATHS;
    } else {
      // Find default files in current directory
      files = DEFAULT_FILES.map((f) => path.resolve(f)).filter((f) => existsSync(f));
      if (files.length === 0) {
        console.log("   No AGENTS.md or CLAUDE.md found in current directory.");
        console.log("   Usage: compress-memory <file> or compress-memory --global");
        process.exit(1);
      }
    }
  }

  let totalSaved = 0;
  let totalOrig = 0;

  for (const file of files) {
    const savings = processFile(file, config);
    if (savings) {
      totalSaved += savings.saved;
      totalOrig += savings.origTokens;
    }
  }

  if (totalOrig > 0) {
    const totalPct = ((totalSaved / totalOrig) * 100).toFixed(1);
    console.log(`\n   📊 Total: ${totalSaved.toLocaleString()} tokens saved (${totalPct}%)`);
    console.log(`   💡 These savings apply to EVERY future session.`);
  }
}

main();
