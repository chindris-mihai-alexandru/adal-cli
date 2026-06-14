import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  compressProse,
  compressToolOutput,
  compressMessages,
  compressToolSchemas,
  compressWithAging,
  deduplicateMessages,
  estimateSavings,
} from "./compression.mjs";

describe("Edge Cases: compressProse", () => {
  test("handles empty string", () => {
    assert.equal(compressProse(""), "");
  });

  test("handles null/undefined", () => {
    assert.equal(compressProse(null), null);
    assert.equal(compressProse(undefined), undefined);
  });

  test("handles string with only code blocks", () => {
    const input = "```python\ndef hello():\n    print('world')\n```";
    const result = compressProse(input);
    assert.ok(result.includes("def hello()"));
    assert.ok(result.includes("print('world')"));
  });

  test("handles deeply nested JSON (protected)", () => {
    const input = 'I think the config is basically {"nested": {"deep": {"value": 42}}} and it should be used very carefully';
    const result = compressProse(input);
    assert.ok(result.includes('"nested"'));
    assert.ok(result.includes('"value": 42'));
  });

  test("handles multiple code blocks interspersed with prose", () => {
    const input = "I think you should basically do this:\n```js\nconst a = 1;\n```\nand then I believe very importantly:\n```js\nconst b = 2;\n```\nwhich is essentially done.";
    const result = compressProse(input);
    assert.ok(result.includes("const a = 1;"));
    assert.ok(result.includes("const b = 2;"));
    assert.ok(!result.includes("I think"));
    assert.ok(!result.includes("basically"));
    assert.ok(!result.includes("essentially"));
  });

  test("preserves numbers and measurements", () => {
    const input = "The response time is basically very slow at 250ms and the file is approximately 15MB in size";
    const result = compressProse(input);
    assert.ok(result.includes("250ms"));
    assert.ok(result.includes("15MB"));
  });

  test("handles unicode content", () => {
    const input = "I think the emoji 🎉 is basically very important for the user interface и это очень важно";
    const result = compressProse(input);
    assert.ok(result.includes("🎉"));
  });

  test("handles very long single line", () => {
    const input = "I think " + "word ".repeat(200) + "is basically the end";
    const result = compressProse(input);
    assert.ok(result.length < input.length);
  });

  test("does not double-compress already concise text", () => {
    const input = "Fix bug in auth module. Check token expiry. Return 401.";
    const result = compressProse(input);
    // Already concise — should not garble it
    assert.ok(result.includes("Fix") || result.includes("fix"));
    assert.ok(result.includes("bug"));
    assert.ok(result.includes("auth"));
  });

  test("handles text that is exactly 50 chars (boundary)", () => {
    const input = "a".repeat(50);
    const result = compressProse(input);
    assert.equal(result, input); // Below threshold, passes through
  });

  test("handles text with only URLs", () => {
    const input = "Check https://example.com/api/v1/users and https://other.com/docs for more details about the situation";
    const result = compressProse(input);
    assert.ok(result.includes("https://example.com/api/v1/users"));
    assert.ok(result.includes("https://other.com/docs"));
  });
});

describe("Edge Cases: compressToolOutput", () => {
  test("handles git diff with binary files", () => {
    const input = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
diff --git a/code.js b/code.js
--- a/code.js
+++ b/code.js
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;`;
    const result = compressToolOutput(input);
    assert.ok(result.includes("diff --git a/image.png"));
    assert.ok(result.includes("-const y = 2;"));
    assert.ok(result.includes("+const y = 3;"));
  });

  test("handles empty git status", () => {
    const input = `On branch main
nothing to commit, working tree clean`;
    const result = compressToolOutput(input);
    assert.ok(result.includes("On branch main"));
  });

  test("handles test output with only passes", () => {
    const input = `  ✓ test one (5ms)
  ✓ test two (3ms)
  ✓ test three (2ms)

Tests: 3 passed, 3 total`;
    const result = compressToolOutput(input);
    assert.ok(result.includes("All tests passed") || result.includes("3 passed"));
  });

  test("handles very large file listing (100+ lines)", () => {
    const lines = Array.from({length: 100}, (_, i) => `file${i}.js`);
    const input = lines.join("\n");
    const result = compressToolOutput(input);
    assert.ok(result.includes("file0.js"));
    assert.ok(result.includes("file19.js"));
    assert.ok(result.includes("80 more entries"));
    assert.ok(!result.includes("file20.js"));
  });
});

describe("Edge Cases: compressMessages", () => {
  test("handles empty messages array", () => {
    assert.deepEqual(compressMessages([]), []);
  });

  test("handles null messages", () => {
    assert.equal(compressMessages(null), null);
  });

  test("handles message with null content", () => {
    const messages = [{ role: "user", content: null }];
    const result = compressMessages(messages);
    assert.equal(result[0].content, null);
  });

  test("handles message with empty string content", () => {
    const messages = [{ role: "user", content: "" }];
    const result = compressMessages(messages);
    assert.equal(result[0].content, "");
  });

  test("preserves non-text parts in multimodal messages", () => {
    const messages = [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
        { type: "text", text: "I think this is basically a very important image that we should carefully consider" },
      ],
    }];
    const result = compressMessages(messages);
    assert.equal(result[0].content[0].image_url.url, "data:image/png;base64,abc123");
    assert.ok(result[0].content[1].text.length < messages[0].content[1].text.length);
  });

  test("handles tool_result content type", () => {
    const messages = [{
      role: "user",
      content: [
        {
          type: "tool_result",
          content: `On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  (use "git add <file>..." to update)
        modified:   src/app.js

no changes added to commit`,
        },
      ],
    }];
    const result = compressMessages(messages);
    assert.ok(result[0].content[0].content.includes("modified:   src/app.js"));
    assert.ok(!result[0].content[0].content.includes("use \"git add"));
  });

  test("handles mixed role messages correctly", () => {
    const messages = [
      { role: "system", content: "You are helpful. In order to assist, take into consideration the user needs." },
      { role: "user", content: "I think you should basically fix the very important bug" },
      { role: "assistant", content: "I think I should basically fix the very important bug" },
      { role: "user", content: "I believe that is essentially correct and very good" },
    ];
    const result = compressMessages(messages);
    // System: light compression
    assert.ok(!result[0].content.includes("take into consideration"));
    assert.ok(result[0].content.includes("consider"));
    // User: full compression
    assert.ok(!result[1].content.includes("I think"));
    assert.ok(!result[1].content.includes("basically"));
    // Assistant: untouched
    assert.equal(result[2].content, messages[2].content);
    // Second user: full compression
    assert.ok(!result[3].content.includes("I believe"));
    assert.ok(!result[3].content.includes("essentially"));
  });
});

describe("Edge Cases: compressToolSchemas", () => {
  test("handles empty tools array", () => {
    assert.deepEqual(compressToolSchemas([]), []);
  });

  test("handles tool with no description", () => {
    const tools = [{ name: "test", input_schema: { type: "object", properties: {} } }];
    const result = compressToolSchemas(tools);
    assert.equal(result[0].name, "test");
  });

  test("handles tool with short description (no truncation)", () => {
    const tools = [{ name: "test", description: "Short desc." }];
    const result = compressToolSchemas(tools);
    assert.equal(result[0].description, "Short desc.");
  });

  test("handles null in tools array", () => {
    const tools = [null, { name: "test" }];
    const result = compressToolSchemas(tools);
    assert.equal(result[0], null);
    assert.equal(result[1].name, "test");
  });
});

describe("Edge Cases: compressWithAging", () => {
  test("handles messages with only assistant responses", () => {
    const messages = Array.from({length: 20}, (_, i) => ({
      role: "assistant",
      content: "Response ".repeat(100) + i,
    }));
    const result = compressWithAging(messages);
    // Assistant messages should never be compressed
    assert.equal(result[0].content, messages[0].content);
    assert.equal(result[19].content, messages[19].content);
  });

  test("handles recentCount larger than messages length", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = compressWithAging(messages, { recentCount: 100 });
    assert.equal(result.length, 2);
  });
});

describe("Edge Cases: deduplicateMessages", () => {
  test("deduplicates identical system messages", () => {
    const systemContent = "You are a helpful assistant. Follow these rules carefully.";
    const messages = [
      { role: "system", content: systemContent },
      { role: "user", content: "hello" },
      { role: "system", content: systemContent },  // Duplicate
      { role: "user", content: "world" },
    ];
    const result = deduplicateMessages(messages);
    assert.equal(result[0].content, systemContent);  // First kept
    assert.equal(result[2].content, "[system context — same as above]");  // Deduped
  });

  test("does not deduplicate different system messages", () => {
    const messages = [
      { role: "system", content: "First system prompt with unique content A" },
      { role: "system", content: "Second system prompt with unique content B" },
    ];
    const result = deduplicateMessages(messages);
    assert.ok(result[0].content.includes("unique content A"));
    assert.ok(result[1].content.includes("unique content B"));
  });

  test("ignores non-system messages", () => {
    const messages = [
      { role: "user", content: "same message" },
      { role: "user", content: "same message" },
    ];
    const result = deduplicateMessages(messages);
    assert.equal(result[0].content, "same message");
    assert.equal(result[1].content, "same message");  // Not deduped (user role)
  });
});

describe("Integration: proxy body compression", () => {
  test("full request body round-trip", () => {
    const body = {
      model: "claude-opus-4-7",
      max_tokens: 4096,
      stream: true,
      tools: [{
        name: "read_file",
        description: "Read the contents of a file from the filesystem. This tool supports reading text files with optional line range selection for targeted reads.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "The absolute or relative path to the file to read" },
            start_line: { type: "integer", description: "Optional starting line number (1-based)" },
            end_line: { type: "integer", description: "Optional ending line number (1-based, inclusive)" },
          },
          required: ["path"],
        },
      }],
      messages: [
        { role: "system", content: "You are a helpful coding assistant. In order to help effectively, take into consideration the user's codebase context." },
        { role: "user", content: "I think you should basically look at the file and tell me what is essentially wrong with it. It is very important." },
        { role: "assistant", content: "I'll read the file and analyze it for issues." },
        { role: "user", content: "Here is basically the output:\nOn branch main\nYour branch is up to date with 'origin/main'.\n\nChanges not staged for commit:\n  (use \"git add <file>...\" to update what will be committed)\n  (use \"git restore <file>...\" to discard changes in working directory)\n        modified:   src/app.js\n        modified:   src/utils.js\n\nno changes added to commit" },
      ],
    };

    const originalJson = JSON.stringify(body);

    // Compress tools
    body.tools = compressToolSchemas(body.tools);
    // Compress messages
    body.messages = compressMessages(body.messages);

    const compressedJson = JSON.stringify(body);
    const savings = estimateSavings(originalJson, compressedJson);

    // Verify compression happened
    assert.ok(parseInt(savings.pct) > 10, `Expected >10% savings, got ${savings.pct}%`);

    // Verify critical content preserved
    assert.ok(compressedJson.includes("claude-opus-4-7"));  // Model preserved
    assert.ok(compressedJson.includes("read_file"));  // Tool name preserved
    assert.ok(compressedJson.includes("path"));  // Param name preserved
    assert.ok(compressedJson.includes("modified:   src/app.js"));  // File changes preserved
    assert.ok(compressedJson.includes("I'll read the file"));  // Assistant untouched

    // Verify compression stripped filler
    assert.ok(!compressedJson.includes("I think you should basically"));
    assert.ok(!compressedJson.includes("take into consideration"));

    // Tool schema should be compressed
    assert.ok(!compressedJson.includes("The absolute or relative path to the file to read"));

    console.log(`    Savings: ${savings.pct}% (${savings.origTokens}→${savings.compTokens} tokens)`);
  });
});
