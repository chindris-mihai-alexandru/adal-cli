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
  test("truncates old messages in long conversations", () => {
    const messages = [];
    // 10 old messages with long content
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: "x".repeat(800) });
      messages.push({ role: "assistant", content: "response " + i });
    }
    const result = compressWithAging(messages, { recentCount: 6 });
    // Old messages (first 14) should be truncated
    const oldUserMsgs = result.slice(0, 14).filter(m => m.role === "user");
    assert.ok(oldUserMsgs.every(m => m.content.length <= 515)); // 500 + "... [truncated]"
    // Recent messages stay longer
    const recentUserMsgs = result.slice(-6).filter(m => m.role === "user");
    assert.ok(recentUserMsgs.length > 0);
  });

  test("short conversations pass through normally", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const result = compressWithAging(messages);
    assert.equal(result.length, 2);
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
