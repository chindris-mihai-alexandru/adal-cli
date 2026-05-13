/**
 * Token compression engine for AdaL CLI
 *
 * Applies Caveman-style compression + RTK-inspired tool output compression
 * to message content before it reaches the LLM provider.
 *
 * Design principles:
 * - NEVER compress code blocks, URLs, file paths, JSON, or technical identifiers
 * - ONLY compress natural language prose (explanations, instructions, context)
 * - Tool outputs (git diff, grep, file contents) get structural compression
 * - Preserve all semantic information — remove only linguistic filler
 */

// --- Protected content markers ---
const PROTECTED_PATTERNS = [
  // Code blocks (fenced)
  /```[\s\S]*?```/g,
  // Inline code
  /`[^`]+`/g,
  // URLs
  /https?:\/\/[^\s)>\]]+/g,
  // File paths (Unix & Windows)
  /(?:\/[\w.-]+)+\/?/g,
  /(?:[A-Z]:\\[\w\\.-]+)/g,
  // JSON objects/arrays
  /\{[\s\S]*?\}/g,
  /\[[\s\S]*?\]/g,
  // Numbers with units
  /\d+(?:\.\d+)?(?:\s*(?:ms|s|min|hr|KB|MB|GB|TB|px|em|rem|%|fps|rpm|req|tok))\b/gi,
  // Environment variables
  /[A-Z][A-Z0-9_]{2,}(?:=\S+)?/g,
  // Shell commands (lines starting with $ or >)
  /^[\$>]\s+.+$/gm,
  // Import/require statements
  /^(?:import|from|require|export)\s.+$/gm,
  // Function signatures
  /(?:function|def|fn|const|let|var)\s+\w+\s*\(/g,
];

// --- Caveman compression rules ---
// Applied to natural language prose only

const FILLER_PHRASES = [
  // Hedging & politeness
  /\b(?:I think|I believe|I would suggest|it seems like|it appears that|in my opinion)\b/gi,
  /\b(?:please note that|it's worth noting that|it should be noted that)\b/gi,
  /\b(?:as you can see|as mentioned (?:above|below|earlier|previously))\b/gi,
  /\b(?:basically|essentially|fundamentally|generally speaking)\b/gi,
  // Redundant transitions
  /\b(?:in order to)\b/gi,  // → "to"
  /\b(?:due to the fact that)\b/gi,  // → "because"
  /\b(?:at this point in time)\b/gi,  // → "now"
  /\b(?:in the event that)\b/gi,  // → "if"
  /\b(?:for the purpose of)\b/gi,  // → "to"
  /\b(?:with regard to|with respect to|in terms of)\b/gi,  // → "about"/"for"
  /\b(?:on the other hand|having said that)\b/gi,
  // Intensifiers (no info content)
  /\b(?:very|extremely|quite|rather|really|somewhat|fairly|pretty much)\b/gi,
  // Verbose connectors
  /\b(?:however|nevertheless|furthermore|moreover|additionally|consequently)\b/gi,
  // Filler starts
  /^(?:So,|Well,|Now,|Okay,|Right,|Alright,)\s/gim,
];

const REPLACEMENTS = [
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bat this point in time\b/gi, "now"],
  [/\bin the event that\b/gi, "if"],
  [/\bfor the purpose of\b/gi, "to"],
  [/\bwith regard to\b/gi, "about"],
  [/\bwith respect to\b/gi, "about"],
  [/\bin terms of\b/gi, "for"],
  [/\ba large number of\b/gi, "many"],
  [/\ba small number of\b/gi, "few"],
  [/\bat the present time\b/gi, "now"],
  [/\bis able to\b/gi, "can"],
  [/\bare able to\b/gi, "can"],
  [/\bin the near future\b/gi, "soon"],
  [/\bin close proximity to\b/gi, "near"],
  [/\bhas the ability to\b/gi, "can"],
  [/\btake into consideration\b/gi, "consider"],
  [/\bmake a decision\b/gi, "decide"],
  [/\bcome to the conclusion\b/gi, "conclude"],
  [/\bgive an indication\b/gi, "indicate"],
  [/\bprovide assistance\b/gi, "help"],
  [/\bit is important to note that\b/gi, "note:"],
  [/\bit is worth mentioning that\b/gi, ""],
  [/\bthe reason (?:why |is (?:that |because ))/gi, "because "],
  [/\bin spite of the fact that\b/gi, "although"],
  [/\buntil such time as\b/gi, "until"],
  [/\bfor the reason that\b/gi, "because"],
];

// Articles — remove when safe (not before proper nouns or ambiguous refs)
const ARTICLE_PATTERN = /\b(?:the|a|an)\s+(?=[a-z])/gi;

// Whitespace normalization
const MULTI_SPACE = /[ \t]{2,}/g;
const MULTI_NEWLINE = /\n{3,}/g;
const TRAILING_SPACE = /[ \t]+$/gm;

// --- RTK-inspired tool output compression ---

const TOOL_OUTPUT_RULES = [
  // Git diff: Remove unchanged context lines, keep only +/- lines and headers
  {
    detect: /^diff --git|^@@.*@@/m,
    compress: (text) => {
      const lines = text.split("\n");
      const kept = [];
      let inHunk = false;
      for (const line of lines) {
        if (line.startsWith("diff --git") || line.startsWith("---") || line.startsWith("+++")) {
          kept.push(line);
          inHunk = false;
        } else if (line.startsWith("@@")) {
          kept.push(line);
          inHunk = true;
        } else if (inHunk && (line.startsWith("+") || line.startsWith("-"))) {
          kept.push(line);
        }
        // Skip context lines (no prefix) — LLM can infer from hunk headers
      }
      return kept.join("\n");
    },
  },
  // Git status: Condense to file list
  {
    detect: /^(?:On branch|Changes|Untracked|modified:|new file:|deleted:)/m,
    compress: (text) => {
      const lines = text.split("\n");
      const kept = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("modified:") || trimmed.startsWith("new file:") ||
            trimmed.startsWith("deleted:") || trimmed.startsWith("renamed:") ||
            trimmed.startsWith("??") || trimmed.startsWith("M ") ||
            trimmed.startsWith("A ") || trimmed.startsWith("D ")) {
          kept.push(trimmed);
        } else if (trimmed.startsWith("On branch") || trimmed.startsWith("Changes") ||
                   trimmed.startsWith("Untracked")) {
          kept.push(trimmed);
        }
      }
      return kept.join("\n");
    },
  },
  // npm/pip install output: Keep only errors and final summary
  {
    detect: /^(?:npm|pip|added|removed|up to date|Successfully installed)/m,
    compress: (text) => {
      const lines = text.split("\n");
      const kept = [];
      for (const line of lines) {
        if (/error|ERR!|warn|WARN|added \d|removed \d|up to date|Successfully/i.test(line)) {
          kept.push(line);
        }
      }
      return kept.length > 0 ? kept.join("\n") : text.split("\n").slice(-3).join("\n");
    },
  },
  // Test output: Keep failures + summary, drop passing tests
  {
    detect: /(?:PASS|FAIL|✓|✗|tests?\s+passed|tests?\s+failed)/im,
    compress: (text) => {
      const lines = text.split("\n");
      const kept = [];
      for (const line of lines) {
        if (/FAIL|✗|✘|error|Error|×|failed/i.test(line)) {
          kept.push(line);
        } else if (/\d+\s+(?:pass|fail|skip|pend|total|suite)/i.test(line)) {
          kept.push(line);  // Summary lines
        } else if (/^Tests?:|^Test Suites?:/i.test(line)) {
          kept.push(line);
        }
      }
      if (kept.length === 0) return "All tests passed.";
      return kept.join("\n");
    },
  },
  // ls/find output: Limit to first 30 entries + count
  {
    detect: (text) => {
      const lines = text.trim().split("\n");
      return lines.length > 30 && lines.every(l => l.length < 200 && !l.includes("  "));
    },
    compress: (text) => {
      const lines = text.trim().split("\n");
      if (lines.length <= 30) return text;
      return lines.slice(0, 30).join("\n") + `\n... (${lines.length - 30} more entries, ${lines.length} total)`;
    },
  },
];

// --- Main compression functions ---

/**
 * Compress a text string using Caveman rules.
 * Only compresses natural language — preserves code, paths, URLs, etc.
 */
export function compressProse(text) {
  if (!text || text.length < 50) return text;

  // Extract and protect code/technical content
  const protectedChunks = [];
  let processed = text;

  for (const pattern of PROTECTED_PATTERNS) {
    processed = processed.replace(pattern, (match) => {
      const idx = protectedChunks.length;
      protectedChunks.push(match);
      return `\x01${idx}\x02`;
    });
  }

  // Apply replacements (verbose → concise)
  for (const [pattern, replacement] of REPLACEMENTS) {
    processed = processed.replace(pattern, replacement);
  }

  // Remove filler phrases
  for (const pattern of FILLER_PHRASES) {
    processed = processed.replace(pattern, "");
  }

  // Remove articles (conservative — only lowercase following word)
  processed = processed.replace(ARTICLE_PATTERN, "");

  // Normalize whitespace
  processed = processed.replace(MULTI_SPACE, " ");
  processed = processed.replace(MULTI_NEWLINE, "\n\n");
  processed = processed.replace(TRAILING_SPACE, "");

  // Clean up sentence starts after removals
  processed = processed.replace(/^\s+/gm, "");
  processed = processed.replace(/\.\s*\./g, ".");
  processed = processed.replace(/,\s*,/g, ",");
  processed = processed.replace(/\s+([.,;:!?])/g, "$1");

  // Restore protected content
  processed = processed.replace(/\x01(\d+)\x02/g, (_, idx) => {
    return protectedChunks[parseInt(idx)];
  });

  return processed;
}

/**
 * Compress tool output (git, npm, test results, file listings).
 * Uses pattern detection to apply appropriate compression strategy.
 */
export function compressToolOutput(text) {
  if (!text || text.length < 100) return text;

  for (const rule of TOOL_OUTPUT_RULES) {
    const matches = typeof rule.detect === "function"
      ? rule.detect(text)
      : rule.detect.test(text);
    if (matches) {
      return rule.compress(text);
    }
  }

  return text;
}

/**
 * Compress a chat message's content.
 * Detects content type and applies appropriate compression.
 */
export function compressMessage(content) {
  if (!content || typeof content !== "string") return content;

  // Detect if this is tool output vs prose
  const isToolOutput = TOOL_OUTPUT_RULES.some(rule => {
    return typeof rule.detect === "function"
      ? rule.detect(content)
      : rule.detect.test(content);
  });

  if (isToolOutput) {
    return compressToolOutput(content);
  }

  return compressProse(content);
}

/**
 * Compress messages array (OpenAI/Anthropic format).
 * Preserves structure, compresses content.
 *
 * Rules:
 * - System messages: Light compression (preserve instructions)
 * - User messages: Full compression
 * - Assistant messages: Never compress (model output, needed for context)
 * - Tool results: RTK-style compression
 */
export function compressMessages(messages) {
  if (!Array.isArray(messages)) return messages;

  return messages.map((msg) => {
    if (!msg || !msg.content) return msg;

    // Never compress assistant responses
    if (msg.role === "assistant") return msg;

    // Handle string content
    if (typeof msg.content === "string") {
      if (msg.role === "system") {
        // Light compression for system prompts — only whitespace + replacements
        let compressed = msg.content;
        for (const [pattern, replacement] of REPLACEMENTS) {
          compressed = compressed.replace(pattern, replacement);
        }
        compressed = compressed.replace(MULTI_SPACE, " ");
        compressed = compressed.replace(MULTI_NEWLINE, "\n\n");
        return { ...msg, content: compressed };
      }

      return { ...msg, content: compressMessage(msg.content) };
    }

    // Handle array content (multimodal messages)
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map((part) => {
          if (part.type === "text" && part.text) {
            return { ...part, text: compressMessage(part.text) };
          }
          if (part.type === "tool_result" && part.content) {
            return { ...part, content: compressToolOutput(part.content) };
          }
          return part;
        }),
      };
    }

    return msg;
  });
}

/**
 * Compress tool schemas (MCP-style).
 * Inspired by Atlassian's mcp-compressor: strips verbose descriptions
 * from tool definitions while preserving parameter structure.
 *
 * Typically saves 70-97% on tool schema tokens.
 */
export function compressToolSchemas(tools) {
  if (!Array.isArray(tools)) return tools;

  return tools.map((tool) => {
    if (!tool) return tool;

    const compressed = { ...tool };

    // Shorten description to first sentence (max 80 chars)
    if (compressed.description && compressed.description.length > 80) {
      const firstSentence = compressed.description.split(/[.!?]\s/)[0];
      compressed.description = firstSentence.slice(0, 80);
    }

    // Strip parameter descriptions but keep structure
    if (compressed.input_schema?.properties) {
      compressed.input_schema = {
        ...compressed.input_schema,
        properties: Object.fromEntries(
          Object.entries(compressed.input_schema.properties).map(([key, val]) => {
            const slim = { type: val.type };
            if (val.enum) slim.enum = val.enum;
            if (val.items) slim.items = { type: val.items.type };
            if (val.default !== undefined) slim.default = val.default;
            return [key, slim];
          })
        ),
      };
    }

    // Same for OpenAI function calling format
    if (compressed.function?.parameters?.properties) {
      compressed.function = {
        ...compressed.function,
        parameters: {
          ...compressed.function.parameters,
          properties: Object.fromEntries(
            Object.entries(compressed.function.parameters.properties).map(([key, val]) => {
              const slim = { type: val.type };
              if (val.enum) slim.enum = val.enum;
              if (val.items) slim.items = { type: val.items.type };
              if (val.default !== undefined) slim.default = val.default;
              return [key, slim];
            })
          ),
        },
      };
      // Shorten function description
      if (compressed.function.description && compressed.function.description.length > 80) {
        compressed.function.description = compressed.function.description.split(/[.!?]\s/)[0].slice(0, 80);
      }
    }

    return compressed;
  });
}

/**
 * Progressive message aging — compress older messages more aggressively.
 * Recent messages (last N) get normal compression.
 * Older messages get heavy compression (remove articles, more filler, truncate).
 *
 * Inspired by Code Mode insight: LLMs rarely need full context from early turns.
 */
export function compressWithAging(messages, { recentCount = 6 } = {}) {
  if (!Array.isArray(messages) || messages.length <= recentCount) {
    return compressMessages(messages);
  }

  const oldMessages = messages.slice(0, -recentCount);
  const recentMessages = messages.slice(-recentCount);

  // Heavy compression for old messages
  const agedOld = oldMessages.map((msg) => {
    if (!msg || !msg.content || msg.role === "assistant") return msg;

    if (typeof msg.content === "string") {
      // For old user messages: aggressive truncation
      let compressed = compressMessage(msg.content);
      // Further truncate if still long
      if (compressed.length > 500) {
        compressed = compressed.slice(0, 500) + "... [truncated]";
      }
      return { ...msg, content: compressed };
    }

    return msg;
  });

  // Normal compression for recent messages
  const compressedRecent = compressMessages(recentMessages);

  return [...agedOld, ...compressedRecent];
}

/**
 * Multi-turn deduplication — detect repeated system prompts/tool schemas
 * across turns and replace with a short reference.
 *
 * Key insight from Code Mode articles: tool schemas are sent on EVERY turn
 * and eat 5-7% of context window. We hash and deduplicate them.
 */
const seenHashes = new Map(); // hash → first occurrence index

export function deduplicateMessages(messages) {
  if (!Array.isArray(messages)) return messages;

  return messages.map((msg, idx) => {
    if (!msg || !msg.content || msg.role !== "system") return msg;

    if (typeof msg.content !== "string") return msg;

    // Simple content hash (fast, not crypto-secure — just for dedup)
    const hash = simpleHash(msg.content);

    if (seenHashes.has(hash) && seenHashes.get(hash) !== idx) {
      // This system message was seen before — replace with short ref
      return { ...msg, content: "[system context — same as above]" };
    }

    seenHashes.set(hash, idx);
    return msg;
  });
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Estimate token savings (rough approximation: 1 token ≈ 4 chars)
 */
export function estimateSavings(original, compressed) {
  const origTokens = Math.ceil(original.length / 4);
  const compTokens = Math.ceil(compressed.length / 4);
  const saved = origTokens - compTokens;
  const pct = origTokens > 0 ? ((saved / origTokens) * 100).toFixed(1) : "0.0";
  return { origTokens, compTokens, saved, pct };
}
