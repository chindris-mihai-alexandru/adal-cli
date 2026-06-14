import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  compressProse,
  compressToolOutput,
  compressMessages,
  compressToolSchemas,
  compressWithAging,
  estimateSavings,
} from "./compression.mjs";

describe("compressProse", () => {
  test("removes filler phrases", () => {
    const input = "I think the reason why this is important is because the function is basically very slow";
    const result = compressProse(input);
    assert.ok(!result.includes("I think"));
    assert.ok(!result.includes("basically"));
    assert.ok(!result.includes("very"));
    assert.ok(result.includes("slow"));
  });

  test("replaces verbose phrases with concise equivalents", () => {
    const input = "In order to fix this, we need to take into consideration the fact that the system is able to handle many requests";
    const result = compressProse(input);
    assert.ok(result.includes("to") || result.includes("To"));
    assert.ok(result.includes("consider"));
    assert.ok(result.includes("can"));
    assert.ok(!result.includes("In order to"));
    assert.ok(!result.includes("take into consideration"));
    assert.ok(!result.includes("is able to"));
  });

  test("removes articles", () => {
    const input = "The database needs an index to improve the performance of the queries in the system";
    const result = compressProse(input);
    // Should have fewer articles
    const articleCount = (result.match(/\b(the|a|an)\s/gi) || []).length;
    const origArticleCount = (input.match(/\b(the|a|an)\s/gi) || []).length;
    assert.ok(articleCount < origArticleCount);
  });

  test("preserves code blocks", () => {
    const input = "I think you should basically use the following code:\n```javascript\nconst x = a + b;\n```\nThis is very important.";
    const result = compressProse(input);
    assert.ok(result.includes("```javascript\nconst x = a + b;\n```"));
  });

  test("preserves URLs", () => {
    const input = "I think you should basically visit https://example.com/path?q=1 for more information";
    const result = compressProse(input);
    assert.ok(result.includes("https://example.com/path?q=1"));
  });

  test("preserves inline code", () => {
    const input = "The function `calculateTotal()` is very important and basically handles the computation";
    const result = compressProse(input);
    assert.ok(result.includes("`calculateTotal()`"));
  });

  test("short text passes through unchanged", () => {
    const input = "Fix the bug.";
    assert.equal(compressProse(input), input);
  });
});

describe("compressToolOutput", () => {
  test("compresses git diff — removes context lines", () => {
    const input = `diff --git a/file.js b/file.js
--- a/file.js
+++ b/file.js
@@ -1,5 +1,5 @@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;
 const w = 5;`;
    const result = compressToolOutput(input);
    assert.ok(result.includes("diff --git"));
    assert.ok(result.includes("-const y = 2;"));
    assert.ok(result.includes("+const y = 3;"));
    assert.ok(!result.includes(" const x = 1;"));  // Context line removed
    assert.ok(!result.includes(" const z = 4;"));
  });

  test("compresses git status — keeps only file changes", () => {
    const input = `On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
        modified:   src/app.js
        modified:   src/utils.js

Untracked files:
  (use "git add <file>..." to include in what will be committed)
        new-file.txt`;
    const result = compressToolOutput(input);
    assert.ok(result.includes("On branch main"));
    assert.ok(result.includes("modified:   src/app.js"));
    assert.ok(result.includes("modified:   src/utils.js"));
    assert.ok(!result.includes("use \"git add"));
    assert.ok(!result.includes("use \"git restore"));
  });

  test("compresses test output — keeps failures and summary", () => {
    const input = `  ✓ test one passes (5ms)
  ✓ test two passes (3ms)
  ✗ test three fails (10ms)
    Expected: 4
    Received: 5
  ✓ test four passes (2ms)

Tests: 1 failed, 3 passed, 4 total`;
    const result = compressToolOutput(input);
    assert.ok(result.includes("✗ test three fails"));
    assert.ok(result.includes("1 failed, 3 passed, 4 total"));
    assert.ok(!result.includes("✓ test one passes"));
  });

  test("compresses npm install — keeps summary only", () => {
    const input = `npm warn deprecated inflight@1.0.6
npm warn deprecated glob@7.2.3
added 245 packages in 12s
42 packages are looking for funding`;
    const result = compressToolOutput(input);
    assert.ok(result.includes("added 245 packages"));
    assert.ok(result.includes("warn"));
  });

  test("short output passes through", () => {
    const input = "OK";
    assert.equal(compressToolOutput(input), input);
  });
});

describe("compressMessages", () => {
  test("compresses user messages", () => {
    const messages = [
      { role: "user", content: "I think you should basically fix the very important bug in order to make the system work properly" },
    ];
    const result = compressMessages(messages);
    assert.ok(result[0].content.length < messages[0].content.length);
    assert.ok(result[0].content.includes("fix"));
    assert.ok(result[0].content.includes("bug"));
  });

  test("never compresses assistant messages", () => {
    const messages = [
      { role: "assistant", content: "I think this is basically very important and in order to fix it we need to consider many things" },
    ];
    const result = compressMessages(messages);
    assert.equal(result[0].content, messages[0].content);
  });

  test("lightly compresses system messages", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant. In order to help the user, take into consideration their requirements." },
    ];
    const result = compressMessages(messages);
    assert.ok(result[0].content.includes("consider"));
    assert.ok(!result[0].content.includes("take into consideration"));
  });

  test("handles multimodal content arrays", () => {
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: "I think you should basically fix this very important issue" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    }];
    const result = compressMessages(messages);
    assert.ok(result[0].content[0].text.length < messages[0].content[0].text.length);
    assert.equal(result[0].content[1].type, "image_url"); // Untouched
  });
});

describe("compressToolSchemas", () => {
  test("shortens tool descriptions", () => {
    const tools = [{
      name: "get_weather",
      description: "This tool retrieves the current weather information for a specified location including temperature, humidity, wind speed, and atmospheric pressure. It supports cities worldwide and returns data in metric or imperial units.",
      input_schema: {
        type: "object",
        properties: {
          location: { type: "string", description: "The city and state, e.g. San Francisco, CA" },
          units: { type: "string", enum: ["metric", "imperial"], description: "The unit system to use for temperature" },
        },
        required: ["location"],
      },
    }];
    const result = compressToolSchemas(tools);
    assert.ok(result[0].description.length <= 80);
    assert.ok(result[0].input_schema.properties.location.type === "string");
    assert.ok(!result[0].input_schema.properties.location.description); // Stripped
    assert.deepEqual(result[0].input_schema.properties.units.enum, ["metric", "imperial"]);
  });

  test("handles OpenAI function format", () => {
    const tools = [{
      type: "function",
      function: {
        name: "search",
        description: "Search the codebase for files matching a query pattern. Supports regex and glob patterns for flexible searching across all project files.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query or pattern to match" },
          },
        },
      },
    }];
    const result = compressToolSchemas(tools);
    assert.ok(result[0].function.description.length <= 80);
    assert.ok(!result[0].function.parameters.properties.query.description);
  });
});

describe("compressWithAging", () => {
  test("ages tool exploration outputs aggressively", () => {
    const messages = [];
    // Old messages with tool output (file listing pattern)
    for (let i = 0; i < 10; i++) {
      const fileList = Array.from({ length: 25 }, (_, j) => `src/file${j}.js`).join("\n");
      messages.push({ role: "user", content: fileList });
      messages.push({ role: "assistant", content: "response " + i });
    }
    const result = compressWithAging(messages, { recentCount: 6 });
    // Old tool-exploration messages should be capped at 200 chars + "... [aged]"
    const oldUserMsgs = result.slice(0, 14).filter(m => m.role === "user");
    assert.ok(oldUserMsgs.every(m => m.content.length <= 215));
  });

  test("preserves error messages with higher cap", () => {
    const messages = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: "TypeError: Cannot read property 'id' of null\n" + "x".repeat(900) });
      messages.push({ role: "assistant", content: "response " + i });
    }
    const result = compressWithAging(messages, { recentCount: 6 });
    const oldUserMsgs = result.slice(0, 14).filter(m => m.role === "user");
    // Errors get 800 char cap (not 200 or 500)
    assert.ok(oldUserMsgs.every(m => m.content.length <= 815)); // 800 + "... [truncated]"
    assert.ok(oldUserMsgs.every(m => m.content.length > 200)); // NOT aggressively truncated
  });

  test("user instructions get prose compression only, no truncation", () => {
    const messages = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: "I think we should basically implement the feature in order to fix the problem. ".repeat(10) });
      messages.push({ role: "assistant", content: "response " + i });
    }
    const result = compressWithAging(messages, { recentCount: 6 });
    const oldUserMsgs = result.slice(0, 14).filter(m => m.role === "user");
    // Should be compressed (filler removed) but not truncated
    assert.ok(oldUserMsgs.every(m => m.content.length < 800)); // Compressed from original
    assert.ok(oldUserMsgs.every(m => !m.content.includes("[truncated]") && !m.content.includes("[aged]")));
  });

  test("short conversations pass through normally", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const result = compressWithAging(messages);
    assert.equal(result.length, 2);
  });

  test("tool output exactly at 200 chars is NOT truncated with [aged] suffix", () => {
    const messages = [];
    // Create a tool-exploration message that compresses to exactly 200 chars
    const fileList = Array.from({ length: 25 }, (_, j) => `f${j}.js`).join("\n");
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: fileList });
      messages.push({ role: "assistant", content: "r" });
    }
    const result = compressWithAging(messages, { recentCount: 4 });
    const oldUserMsgs = result.slice(0, 16).filter(m => m.role === "user");
    // Messages ≤200 chars should NOT have [aged] suffix
    for (const m of oldUserMsgs) {
      if (m.content.length <= 200) {
        assert.ok(!m.content.includes("[aged]"));
      }
    }
  });

  test("assistant messages are never aged regardless of content", () => {
    const messages = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: "short" });
      messages.push({ role: "assistant", content: "x".repeat(2000) });
    }
    const result = compressWithAging(messages, { recentCount: 4 });
    const oldAssistantMsgs = result.slice(0, 16).filter(m => m.role === "assistant");
    // Assistant messages must remain untouched
    assert.ok(oldAssistantMsgs.every(m => m.content.length === 2000));
  });
});

describe("compressMessages — system message handling", () => {
  test("second system message gets full prose compression", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant. In order to help users, please note that it is important to note that you should respond clearly." },
      { role: "system", content: "I think the user basically wants us to provide assistance in order to achieve their goals." },
      { role: "user", content: "hello" },
    ];
    const result = compressMessages(messages);
    // First system: only replacements ("In order to" → "to"), keeps fillers like "please note that"
    assert.ok(result[0].content.includes("helpful assistant"));
    assert.ok(result[0].content.includes("please note"));
    // Second system: full compressProse removes "I think", "basically", and replaces "in order to"
    assert.ok(!result[1].content.includes("I think"));
    assert.ok(!result[1].content.includes("basically"));
    assert.ok(!result[1].content.includes("in order to"));
  });

  test("multimodal content passes through without error", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: [
        { type: "text", text: "I think this is basically a test in order to verify things work" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ]},
    ];
    const result = compressMessages(messages);
    // Text part should be compressed
    assert.ok(!result[1].content[0].text.includes("I think"));
    assert.ok(!result[1].content[0].text.includes("basically"));
    // Image part should be unchanged
    assert.equal(result[1].content[1].type, "image_url");
    assert.equal(result[1].content[1].image_url.url, "data:image/png;base64,abc");
  });
});

describe("compressToolOutput — graduated rules", () => {
  test("git diff: large diffs (>300 changed lines) produce per-file summary", () => {
    // Generate a diff with >300 actual changes (not counting --- or +++ headers)
    let diff = "";
    for (let i = 0; i < 60; i++) {
      diff += `diff --git a/file${i}.js b/file${i}.js\n`;
      diff += `--- a/file${i}.js\n`;
      diff += `+++ b/file${i}.js\n`;
      diff += `@@ -1,5 +1,10 @@\n`;
      for (let j = 0; j < 6; j++) {
        diff += `+added line ${j}\n`;
        diff += `-removed line ${j}\n`;
      }
    }
    const result = compressToolOutput(diff);
    assert.ok(result.includes("diff summary"));
    assert.ok(result.includes("file0.js"));
    assert.ok(result.includes("file59.js"));
    // Should NOT count --- and +++ as changes
    assert.ok(!result.includes("(+7/")); // Would be 7 if +++ counted
    assert.ok(result.includes("(+6/-6)")); // Correct: 6 additions, 6 deletions per file
  });

  test("git diff: small diffs (<= 300 changed lines) keep full output", () => {
    const diff = `diff --git a/file.js b/file.js
--- a/file.js
+++ b/file.js
@@ -1,3 +1,3 @@
+new line
-old line`;
    const result = compressToolOutput(diff);
    assert.ok(result.includes("+new line"));
    assert.ok(result.includes("-old line"));
    assert.ok(!result.includes("diff summary"));
  });

  test("grep output: caps at 10 matches", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `src/file${i}.js:${i + 1}: match content here`);
    const input = lines.join("\n");
    const result = compressToolOutput(input);
    assert.ok(result.includes("src/file0.js:1:"));
    assert.ok(result.includes("src/file9.js:10:"));
    assert.ok(result.includes("10 more matches"));
    assert.ok(!result.includes("src/file10.js"));
  });

  test("large file content: keeps head + tail", () => {
    // Use content that won't trigger grep/diff/test/npm/ls rules
    const lines = Array.from({ length: 200 }, (_, i) => `export function handler${i}(req, res) { return res.json({ ok: true }); }`);
    const input = lines.join("\n");
    const result = compressToolOutput(input);
    assert.ok(result.includes("handler0"));
    assert.ok(result.includes("handler29"));
    assert.ok(result.includes("lines omitted"));
    assert.ok(result.includes("handler199"));
    assert.ok(!result.includes("handler30"));
  });
});

describe("estimateSavings", () => {
  test("calculates correct percentages", () => {
    const result = estimateSavings("a".repeat(400), "a".repeat(300));
    assert.equal(result.origTokens, 100);
    assert.equal(result.compTokens, 75);
    assert.equal(result.saved, 25);
    assert.equal(result.pct, "25.0");
  });
});
