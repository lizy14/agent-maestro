import * as assert from "assert";

import {
  createDshManagedBlock,
  updateDshSettingsContent,
} from "../../utils/dshSettings";

suite("DSH Settings Utils Test Suite", () => {
  const block = createDshManagedBlock({
    baseURL: "http://127.0.0.1:23333/api/openai/v1",
    modelId: 'model-"quoted"',
    modelContextWindow: 128000,
  });

  test("creates valid escaped provider content", () => {
    assert.ok(block.includes("apiKeyEnv: AGENT_MAESTRO_API_KEY"));
    assert.ok(block.includes("api: openai-responses"));
    assert.ok(block.includes('id: "model-\\\"quoted\\\""'));
    assert.ok(block.includes("contextWindow: 128000"));
  });

  test("writes the managed block into an empty file", () => {
    const result = updateDshSettingsContent("", block);
    assert.strictEqual(result.blockedByExistingLlmPiAi, false);
    assert.strictEqual(result.content, `${block}\n`);
  });

  test("replaces an existing managed block and preserves surrounding content", () => {
    const original = `before: true\n\n${createDshManagedBlock({
      baseURL: "http://old",
      modelId: "old-model",
    })}\n\nafter: true\n`;
    const result = updateDshSettingsContent(original, block);
    assert.strictEqual(result.blockedByExistingLlmPiAi, false);
    assert.strictEqual(
      result.content,
      `before: true\n\n${block}\n\nafter: true\n`,
    );
  });

  test("refuses to overwrite an unmanaged llm-pi-ai section", () => {
    const original = "theme: dark\nllm-pi-ai:\n  providers: {}\n";
    const result = updateDshSettingsContent(original, block);
    assert.strictEqual(result.blockedByExistingLlmPiAi, true);
    assert.strictEqual(result.content, original);
  });

  test("refuses to append when a managed block marker is orphaned", () => {
    const original = "# >>> Agent Maestro DSH provider >>>\ntheme: dark\n";
    const result = updateDshSettingsContent(original, block);
    assert.strictEqual(result.blockedByExistingLlmPiAi, true);
    assert.strictEqual(result.content, original);
  });

  test("appends to unrelated settings with one blank line", () => {
    const result = updateDshSettingsContent("theme: dark\n", block);
    assert.strictEqual(result.content, `theme: dark\n\n${block}\n`);
  });
});
