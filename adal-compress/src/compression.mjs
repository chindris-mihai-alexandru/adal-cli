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
  // Git diff: Remove context lines; if >300 changed lines, summarize per-file
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
      }
      // If still too large after stripping context, produce per-file summary
      // Exclude --- and +++ header lines from changed line count
      const changedLines = kept.filter(l =>
        (l.startsWith("+") && !l.startsWith("+++")) ||
        (l.startsWith("-") && !l.startsWith("---"))
      );
      if (changedLines.length > 300) {
        const files = new Map();
        let currentFile = "(unknown)";
        for (const line of kept) {
          if (line.startsWith("diff --git")) {
            const match = line.match(/b\/(.+)$/);
            currentFile = match ? match[1] : "(unknown)";
            if (!files.has(currentFile)) files.set(currentFile, { add: 0, del: 0 });
          } else if (line.startsWith("+") && !line.startsWith("+++")) {
            if (files.has(currentFile)) files.get(currentFile).add++;
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            if (files.has(currentFile)) files.get(currentFile).del++;
          }
        }
        const summary = [...files.entries()]
          .map(([f, c]) => `  ${f} (+${c.add}/-${c.del})`)
          .join("\n");
        return `diff summary (${changedLines.length} changed lines across ${files.size} files):\n${summary}`;
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
  // ls/find output: Limit to first 20 entries + count
  // Heuristic: lines are short, path-like (no code syntax like {, (, =, ;)
  {
    detect: (text) => {
      const lines = text.trim().split("\n");
      return lines.length > 20 && lines.every(l =>
        l.length < 200 && !l.includes("  ") && !l.includes("{") && !l.includes("(") && !l.includes(";")
      );
    },
    compress: (text) => {
      const lines = text.trim().split("\n");
      if (lines.length <= 20) return text;
      return lines.slice(0, 20).join("\n") + `\n... (${lines.length - 20} more entries, ${lines.length} total)`;
    },
  },
  // Grep output: Cap at 10 matches + count of remaining
  // Matches "filename:linenum:" or "linenum:" patterns (grep -n format)
  {
    detect: /^[^\s]+:\d+:[^\d]|^\d+[:\-].{10,}/m,
    compress: (text) => {
      const lines = text.trim().split("\n");
      if (lines.length <= 10) return text;
      return lines.slice(0, 10).join("\n") + `\n... (${lines.length - 10} more matches, ${lines.length} total)`;
    },
  },
  // Large file content (>150 lines, not matched by prior rules): keep head + tail
  {
    detect: (text) => {
      const lines = text.split("\n");
      return lines.length > 150;
    },
    compress: (text) => {
      const lines = text.split("\n");
      if (lines.length <= 150) return text;
      return lines.slice(0, 30).join("\n") +
        `\n... (${lines.length - 40} lines omitted)\n` +
        lines.slice(-10).join("\n");
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
 * Detect whether text content matches tool output patterns.
 * Reusable for classification without triggering compression.
 */
export function isToolOutputContent(text) {
  if (!text || text.length < 100) return false;
  return TOOL_OUTPUT_RULES.some(rule => {
    return typeof rule.detect === "function"
      ? rule.detect(text)
      : rule.detect.test(text);
  });
}

/**
 * Generate a 3-emoji triadic signature for content based on its type.
 * Inspired by Signal Zero's Peircean triads — emojis activate dense
 * semantic clusters in LLM latent space, giving the model a "feel"
 * for what the content represents without reading it.
 *
 * Returns: { triad: string, label: string }
 */
export function getContentTriad(text) {
  if (!text || typeof text !== "string") return { triad: "📋💬📌", label: "content" };

  // Priority order matches TOOL_OUTPUT_RULES: most specific patterns first
  // Git diff
  if (/^diff --git|^@@.*@@/m.test(text)) {
    return { triad: "📝✏️🔀", label: "diff" };
  }
  // Git status
  if (/^(?:On branch|Changes|Untracked|modified:|new file:)/m.test(text)) {
    return { triad: "📂🔄📋", label: "git status" };
  }
  // npm/pip output (exclude errors — those should get error triad)
  if (/^(?:npm|pip|added|removed|up to date|Successfully installed)/m.test(text) && !/ERR!|error/i.test(text)) {
    return { triad: "📦⬇️✅", label: "install" };
  }
  // Test output (requires test-specific context, not just "failed" in prose)
  if (/(?:^(?:PASS|FAIL)\b|^Tests?:|✓|✗|tests?\s+(?:passed|failed)|\d+\s+(?:passing|failing)|^\s*\d+\s+(?:pass|fail|skip))/im.test(text)) {
    return { triad: "🧪✅📊", label: "tests" };
  }
  // Error/traceback (after tests — catches genuine errors without test markers)
  if (/(?:error|Error|ERR!|FAILURE|\bfailed\b|traceback|TypeError|ReferenceError|SyntaxError|panic|refused|denied)/m.test(text)) {
    return { triad: "❌🐛📍", label: "error" };
  }
  // File listing (paths)
  if (/^[^\s{(;]+\.[a-z]{1,5}$/m.test(text) && text.split("\n").length > 5) {
    return { triad: "📁📋🔍", label: "file listing" };
  }
  // Grep results
  if (/^[^\s]+:\d+:/m.test(text)) {
    return { triad: "🔎📍💡", label: "search results" };
  }
  // Code/source (requires code syntax: identifier+paren/equals after keyword)
  if (/(?:function\s+\w+\s*\(|def \w+|fn \w+|(?:const|let|var)\s+\w+\s*=|class \w+|^import |^export )/m.test(text)) {
    return { triad: "🔧💻⚙️", label: "source code" };
  }
  // Config/JSON-like (word boundaries prevent matching "export", "localhost" in prose)
  if (/^\s*[{[]|":\s*["{[\d]|\bport\b|\bhost\b|\bconfig\b/m.test(text)) {
    return { triad: "⚙️📄🔒", label: "config" };
  }
  // Default
  return { triad: "📋💬📌", label: "content" };
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

  // Detect if this is tool output vs prose (reuses isToolOutputContent)
  const isToolOutput = isToolOutputContent(content);

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

  let systemIdx = 0;
  return messages.map((msg) => {
    if (!msg || !msg.content) return msg;

    // Never compress assistant responses
    if (msg.role === "assistant") return msg;

    // Handle string content
    if (typeof msg.content === "string") {
      if (msg.role === "system") {
        systemIdx++;
        if (systemIdx === 1) {
          // First system message: light compression only (core instruction prompt)
          let compressed = msg.content;
          for (const [pattern, replacement] of REPLACEMENTS) {
            compressed = compressed.replace(pattern, replacement);
          }
          compressed = compressed.replace(MULTI_SPACE, " ");
          compressed = compressed.replace(MULTI_NEWLINE, "\n\n");
          return { ...msg, content: compressed };
        }
        // Subsequent system messages: full prose compression (injected context)
        return { ...msg, content: compressProse(msg.content) };
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
 * Classify a message's content type for aging decisions.
 * Returns: "tool-exploration" | "error" | "edit" | "user-instruction" | "other"
 */
function classifyMessageContent(content) {
  if (!content || typeof content !== "string") return "other";

  // Error/failure output — preserve more (critical context)
  if (/(?:error|Error|ERR!|FAIL|traceback|TypeError|ReferenceError|SyntaxError|Exception)/m.test(content)) {
    return "error";
  }

  // Edit confirmations — diff-like or creation language
  if (/^(?:diff --git|@@|\+\+\+|---)/m.test(content) ||
      /(?:created|modified|updated|wrote|saved)\s+(?:file|successfully)/i.test(content)) {
    return "edit";
  }

  // Tool exploration output — reuses isToolOutputContent()
  if (isToolOutputContent(content)) return "tool-exploration";

  return "user-instruction";
}

/**
 * Progressive message aging — compress older messages based on content type.
 * Recent messages (last N) get normal compression.
 * Older messages get content-aware aging:
 *   - Tool exploration: aggressive (first+last line, cap 200 chars)
 *   - Errors: preserved (cap 800 chars)
 *   - Edits: medium (header + summary, cap 300 chars)
 *   - User instructions: light (compressProse only, no truncation)
 *
 * Inspired by Focus paper: exploration outputs are highest-waste content.
 */
export function compressWithAging(messages, { recentCount = 6 } = {}) {
  if (!Array.isArray(messages) || messages.length <= recentCount) {
    return compressMessages(messages);
  }

  const oldMessages = messages.slice(0, -recentCount);
  const recentMessages = messages.slice(-recentCount);

  // Content-aware compression for old messages
  const agedOld = oldMessages.map((msg) => {
    if (!msg || !msg.content || msg.role === "assistant") return msg;

    if (typeof msg.content === "string") {
      const type = classifyMessageContent(msg.content);
      let compressed;

      switch (type) {
        case "tool-exploration":
          // Aggressive: first + last line, cap at 200 chars
          compressed = compressMessage(msg.content);
          if (compressed.length > 200) {
            const lines = compressed.split("\n").filter(l => l.trim());
            if (lines.length > 2) {
              compressed = lines[0] + "\n...\n" + lines[lines.length - 1];
            }
            if (compressed.length > 200) {
              compressed = compressed.slice(0, 200) + "... [aged]";
            }
          }
          break;

        case "error":
          // Preserve more — errors are critical context
          compressed = compressMessage(msg.content);
          if (compressed.length > 800) {
            compressed = compressed.slice(0, 800) + "... [truncated]";
          }
          break;

        case "edit":
          // Medium: keep header + summary, cap at 300 chars
          compressed = compressMessage(msg.content);
          if (compressed.length > 300) {
            const lines = compressed.split("\n");
            compressed = lines.slice(0, 3).join("\n");
            if (compressed.length > 300) {
              compressed = compressed.slice(0, 300) + "... [aged]";
            }
          }
          break;

        case "user-instruction":
          // Light: prose compression only, no truncation
          compressed = compressProse(msg.content);
          break;

        default:
          // Fallback: standard compression + moderate truncation
          compressed = compressMessage(msg.content);
          if (compressed.length > 500) {
            compressed = compressed.slice(0, 500) + "... [truncated]";
          }
          break;
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
export function deduplicateMessages(messages) {
  if (!Array.isArray(messages)) return messages;

  // Scoped per-call — only deduplicates within this messages array
  const seenHashes = new Map();

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

export function simpleHash(str) {
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
