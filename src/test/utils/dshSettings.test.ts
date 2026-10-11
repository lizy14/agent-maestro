import * as assert from "assert";
import * as os from "os";
import * as path from "path";

import {
  DSH_MANAGED_BLOCK_END,
  DSH_MANAGED_BLOCK_START,
  createDshManagedBlock,
  getDshPatchPath,
  getDshSettingsPath,
  updateDshSettingsContent,
} from "../../utils/dshSettings";

suite("DSH Settings Utils Test Suite", () => {
  const baseURL = "http://127.0.0.1:23333/api/openai/v1";
  const modelId = 'model-"quoted"';
  const block = createDshManagedBlock({
    baseURL,
    modelId,
    modelContextWindow: 128000,
  });
  const legacyBlock = createDshManagedBlock({
    baseURL,
    modelId,
    modelContextWindow: 128000,
    format: "legacy-settings",
  });

  function withDshHome(value: string | undefined, callback: () => void): void {
    const previous = process.env.DSH_HOME;
    try {
      if (value === undefined) {
        delete process.env.DSH_HOME;
      } else {
        process.env.DSH_HOME = value;
      }
      callback();
    } finally {
      if (previous === undefined) {
        delete process.env.DSH_HOME;
      } else {
        process.env.DSH_HOME = previous;
      }
    }
  }

  function assertBlocked(original: string): void {
    assert.deepStrictEqual(updateDshSettingsContent(original, block), {
      content: original,
      blockedByExistingLlmPiAi: true,
    });
  }

  test("defaults to the desktop patch's two id-targeted plugin entries", () => {
    assert.strictEqual(
      block,
      [
        DSH_MANAGED_BLOCK_START,
        "- id: llm-pi-ai",
        '  name: "@deepseek-ai/dsh-llm-pi-ai"',
        "  config:",
        "    providers:",
        "      agent-maestro:",
        '        displayName: "Agent Maestro"',
        "        apiKeyEnv: AGENT_MAESTRO_API_KEY",
        "        api: openai-completions",
        `        baseURL: ${JSON.stringify(`${baseURL}/`)}`,
        "        models:",
        `          - id: ${JSON.stringify(modelId)}`,
        "            contextWindow: 128000",
        "- id: agent-default-model",
        '  name: "@deepseek-ai/dsh-agent-default-model"',
        "  config:",
        "    provider: agent-maestro",
        `    model: ${JSON.stringify(modelId)}`,
        DSH_MANAGED_BLOCK_END,
      ].join("\n"),
    );
    assert.strictEqual(block.match(/^- id:/gm)?.length, 2);
    assert.ok(!/^llm-pi-ai:/m.test(block));
    assert.ok(!/\binput:/.test(block));
    assert.ok(!block.includes("openai-responses"));
  });

  test("explicit profile-patch output matches the default format", () => {
    assert.strictEqual(
      createDshManagedBlock({
        baseURL,
        modelId,
        modelContextWindow: 128000,
        format: "profile-patch",
      }),
      block,
    );
  });

  test("profile-patch omits contextWindow when the selected model's limit is unknown", () => {
    const result = createDshManagedBlock({ baseURL, modelId });
    assert.ok(!result.includes("contextWindow:"));
    assert.ok(!/\binput:/.test(result));
  });

  test("profile-patch uses the runtime model label without changing the selected model id", () => {
    const result = createDshManagedBlock({
      baseURL,
      modelId: "gpt-6.1-sol",
      modelName: "GPT-6.1 Sol (Agent Maestro)",
      modelContextWindow: 921793,
      modelMaxOutputTokens: 131072,
      modelInput: ["text", "image"],
    });
    assert.ok(result.includes('        displayName: "Agent Maestro"\n'));
    assert.ok(result.includes('          - id: "gpt-6.1-sol"\n'));
    assert.ok(
      result.includes('            name: "GPT-6.1 Sol (Agent Maestro)"\n'),
    );
    assert.ok(result.includes("            contextWindow: 921793\n"));
    assert.ok(result.includes("            maxTokens: 131072\n"));
    assert.ok(!result.includes("contextWindow: 131072"));
    assert.ok(!result.includes("maxTokens: 921793"));
    assert.ok(result.includes('    model: "gpt-6.1-sol"\n'));
  });

  test("profile-patch safely escapes the optional model label", () => {
    const modelName = 'GPT-6.1 "Sol"\\variant\nnext: value (Agent Maestro)';
    const result = createDshManagedBlock({ baseURL, modelId, modelName });
    assert.ok(
      result.includes(`            name: ${JSON.stringify(modelName)}\n`),
    );
    assert.ok(!/^next:/m.test(result));
    assert.ok(result.includes(`    model: ${JSON.stringify(modelId)}\n`));
  });

  test("profile-patch omits the model label when it is unknown", () => {
    const result = createDshManagedBlock({ baseURL, modelId });
    assert.ok(!/^            name:/m.test(result));
  });

  for (const modelContextWindow of [1, 8192, 128000, 921793, 1048576]) {
    test(`profile-patch preserves the selected model's actual context limit ${modelContextWindow}`, () => {
      const result = createDshManagedBlock({
        baseURL,
        modelId,
        modelContextWindow,
      });
      assert.ok(
        result.includes(
          `          - id: ${JSON.stringify(modelId)}\n            contextWindow: ${modelContextWindow}\n`,
        ),
      );
      assert.strictEqual(result.match(/contextWindow:/g)?.length, 1);
      assert.ok(!/\binput:/.test(result));
    });
  }

  for (const format of ["profile-patch", "legacy-settings"] as const) {
    for (const modelContextWindow of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
      test(`${format} rejects invalid context limit ${String(modelContextWindow)}`, () => {
        assert.throws(() =>
          createDshManagedBlock({
            baseURL,
            modelId,
            modelContextWindow,
            format,
          }),
        );
      });
    }
  }

  test("profile-patch omits unknown output limit and input capability", () => {
    const result = createDshManagedBlock({ baseURL, modelId });
    assert.ok(!/\b(?:maxTokens|input):/.test(result));
  });

  test("profile-patch emits actual context, output limit and image capability together", () => {
    const result = createDshManagedBlock({
      baseURL,
      modelId,
      modelContextWindow: 128000,
      modelMaxOutputTokens: 16384,
      modelInput: ["text", "image"],
    });
    assert.ok(result.includes("            contextWindow: 128000\n"));
    assert.ok(result.includes("            maxTokens: 16384\n"));
    assert.ok(
      result.includes(
        "            input:\n              - text\n              - image\n",
      ),
    );
    assert.strictEqual(result.match(/\bmaxTokens:/g)?.length, 1);
    assert.strictEqual(result.match(/\binput:/g)?.length, 1);
    assert.ok(result.includes(`    model: ${JSON.stringify(modelId)}\n`));
  });

  test("profile-patch emits text-only input only when explicitly supplied", () => {
    const result = createDshManagedBlock({
      baseURL,
      modelId,
      modelInput: ["text"],
    });
    assert.ok(result.includes("            input:\n              - text\n"));
    assert.ok(!result.includes("- image"));
    assert.ok(!/\b(?:contextWindow|maxTokens):/.test(result));
  });

  for (const modelMaxOutputTokens of [
    1,
    8192,
    16384,
    Number.MAX_SAFE_INTEGER,
  ]) {
    test(`profile-patch preserves actual output limit ${modelMaxOutputTokens}`, () => {
      const result = createDshManagedBlock({
        baseURL,
        modelId,
        modelMaxOutputTokens,
      });
      assert.ok(
        result.includes(`            maxTokens: ${modelMaxOutputTokens}\n`),
      );
      assert.ok(!/\b(?:contextWindow|input):/.test(result));
    });
  }

  for (const format of ["profile-patch", "legacy-settings"] as const) {
    for (const modelMaxOutputTokens of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      test(`${format} rejects invalid output limit ${String(modelMaxOutputTokens)}`, () => {
        assert.throws(() =>
          createDshManagedBlock({
            baseURL,
            modelId,
            modelMaxOutputTokens,
            format,
          }),
        );
      });
    }
    test(`${format} rejects an unsafe integer context limit`, () => {
      assert.throws(() =>
        createDshManagedBlock({
          baseURL,
          modelId,
          modelContextWindow: Number.MAX_SAFE_INTEGER + 1,
          format,
        }),
      );
    });
  }

  for (const suffix of ["", "/", "///"]) {
    test(`normalizes the patch base URL to one trailing slash (${JSON.stringify(suffix)})`, () => {
      const result = createDshManagedBlock({
        baseURL: `${baseURL}${suffix}`,
        modelId,
      });
      assert.ok(result.includes(`baseURL: ${JSON.stringify(`${baseURL}/`)}`));
    });
  }

  test("escapes model and URL scalars without introducing YAML lines", () => {
    const selectedModel = 'model\nnext: value\\"quoted"';
    const url = 'http://localhost/"quoted"\nnext: value';
    const result = createDshManagedBlock({
      baseURL: url,
      modelId: selectedModel,
    });
    assert.ok(result.includes(`baseURL: ${JSON.stringify(`${url}/`)}`));
    assert.ok(result.includes(`- id: ${JSON.stringify(selectedModel)}`));
    assert.ok(result.includes(`model: ${JSON.stringify(selectedModel)}`));
    assert.ok(!/^next:/m.test(result));
  });

  test("changing the selected model updates both provider and agent default", () => {
    const selectedModel = "new-selected-model";
    const nextBlock = createDshManagedBlock({
      baseURL,
      modelId: selectedModel,
    });
    const result = updateDshSettingsContent(`${block}\n`, nextBlock);
    assert.strictEqual(result.blockedByExistingLlmPiAi, false);
    assert.strictEqual(result.content, `${nextBlock}\n`);
    assert.ok(result.content.includes(`- id: "${selectedModel}"`));
    assert.ok(result.content.includes(`model: "${selectedModel}"`));
    assert.ok(!result.content.includes(JSON.stringify(modelId)));
  });

  test("explicit legacy-settings preserves the mapping, responses API and model metadata", () => {
    assert.strictEqual(
      legacyBlock,
      [
        DSH_MANAGED_BLOCK_START,
        "llm-pi-ai:",
        "  providers:",
        "    agent-maestro:",
        "      apiKeyEnv: AGENT_MAESTRO_API_KEY",
        "      api: openai-responses",
        `      baseURL: ${JSON.stringify(baseURL)}`,
        "      models:",
        `        - id: ${JSON.stringify(modelId)}`,
        "          input:",
        "            - text",
        "          contextWindow: 128000",
        DSH_MANAGED_BLOCK_END,
      ].join("\n"),
    );
    assert.ok(!legacyBlock.includes("agent-default-model"));
  });

  test("legacy contextWindow remains optional and its URL remains unchanged", () => {
    const result = createDshManagedBlock({
      baseURL: `${baseURL}///`,
      modelId,
      format: "legacy-settings",
    });
    assert.ok(!result.includes("contextWindow:"));
    assert.ok(result.includes(`baseURL: ${JSON.stringify(`${baseURL}///`)}`));
    assert.ok(result.includes("input:\n            - text"));
  });

  test("explicit legacy-settings appends to unrelated mapping settings", () => {
    assert.deepStrictEqual(
      updateDshSettingsContent("theme: dark\n", legacyBlock, "legacy-settings"),
      {
        content: `theme: dark\n\n${legacyBlock}\n`,
        blockedByExistingLlmPiAi: false,
      },
    );
  });

  test("explicit legacy-settings replaces its managed mapping and preserves surrounding settings", () => {
    const original = `theme: dark\n\n${legacyBlock}\n\nother: true\n`;
    const replacement = createDshManagedBlock({
      baseURL: "http://new",
      modelId: "new-model",
      format: "legacy-settings",
    });
    assert.deepStrictEqual(
      updateDshSettingsContent(original, replacement, "legacy-settings"),
      {
        content: `theme: dark\n\n${replacement}\n\nother: true\n`,
        blockedByExistingLlmPiAi: false,
      },
    );
  });

  for (const key of ["llm-pi-ai", '"llm-pi-ai"', "'llm-pi-ai'"]) {
    test(`legacy-settings rejects the unmanaged mapping key ${key}`, () => {
      const original = `theme: dark\n${key}:\n  providers: {}\n`;
      assert.deepStrictEqual(
        updateDshSettingsContent(original, legacyBlock, "legacy-settings"),
        { content: original, blockedByExistingLlmPiAi: true },
      );
    });
  }

  test("getDshPatchPath uses the desktop profile and default DSH home", () => {
    withDshHome(undefined, () => {
      assert.strictEqual(
        getDshPatchPath(),
        path.join(
          os.homedir(),
          ".dsh",
          "profiles",
          "desktop",
          "cordis.patch.yml",
        ),
      );
    });
  });

  test("getDshPatchPath trims a home override and accepts safe profile names", () => {
    const home = path.join(os.tmpdir(), "dsh home override");
    withDshHome(`  ${home}  `, () => {
      assert.strictEqual(
        getDshPatchPath(),
        path.join(home, "profiles", "desktop", "cordis.patch.yml"),
      );
      assert.strictEqual(
        getDshPatchPath("Desktop_2-test"),
        path.join(home, "profiles", "Desktop_2-test", "cordis.patch.yml"),
      );
      assert.strictEqual(
        getDshSettingsPath(),
        path.join(home, "settings.yaml"),
      );
    });
  });

  test("a blank DSH_HOME falls back to the user's home", () => {
    withDshHome(" \t ", () => {
      assert.strictEqual(
        getDshPatchPath(),
        path.join(
          os.homedir(),
          ".dsh",
          "profiles",
          "desktop",
          "cordis.patch.yml",
        ),
      );
    });
  });

  test("getDshPatchPath accepts a single-letter or single-number profile", () => {
    for (const profile of ["a", "7"]) {
      assert.strictEqual(
        getDshPatchPath(profile),
        path.join(
          path.dirname(getDshSettingsPath()),
          "profiles",
          profile,
          "cordis.patch.yml",
        ),
      );
    }
  });

  for (const profile of [
    "",
    ".",
    "..",
    "../desktop",
    "desktop/../../outside",
    "desktop\\..\\outside",
    "/absolute",
    "C:\\outside",
    "desktop:name",
    " desktop",
    "desktop ",
    "desktop\n",
    "_desktop",
    "-desktop",
  ]) {
    test(`getDshPatchPath rejects unsafe profile ${JSON.stringify(profile)}`, () => {
      assert.throws(
        () => getDshPatchPath(profile),
        /profile name containing only letters, numbers, underscores, and hyphens/,
      );
    });
  }

  for (const original of ["", "[]", "[]\n", "  []  \n"]) {
    test(`writes the managed array into empty content ${JSON.stringify(original)}`, () => {
      assert.deepStrictEqual(updateDshSettingsContent(original, block), {
        content: `${block}\n`,
        blockedByExistingLlmPiAi: false,
      });
    });
  }

  test("preserves comment-only content when appending the array", () => {
    const original = "# desktop overrides\n# keep this comment\n";
    assert.deepStrictEqual(updateDshSettingsContent(original, block), {
      content: `${original}\n${block}\n`,
      blockedByExistingLlmPiAi: false,
    });
  });

  test("removes an empty-array document while preserving its comments", () => {
    const original = "# desktop overrides\n[]\n# keep this comment\n";
    const result = updateDshSettingsContent(original, block);
    assert.strictEqual(result.blockedByExistingLlmPiAi, false);
    assert.ok(result.content.includes("# desktop overrides\n"));
    assert.ok(result.content.includes("# keep this comment\n"));
    assert.ok(!/^\s*\[\]\s*$/m.test(result.content));
    assert.ok(result.content.endsWith(`${block}\n`));
  });

  test("fails closed and preserves unrelated array entries with nested config", () => {
    const original = [
      "# unrelated plugin",
      "- id: custom-plugin",
      '  name: "@example/custom-plugin"',
      "  config:",
      "    enabled: true",
      "    models:",
      '      - id: "llm-pi-ai"',
      '        name: "not-a-plugin-identifier"',
      "",
    ].join("\n");
    assertBlocked(original);
    assertBlocked(`${original}\n${block}\n`);
    assertBlocked(`${block}\n${original}`);
  });

  test("updates owned block while preserving unrelated array entries", () => {
    const before = "# before\n- id: before\n  config:\n    enabled: true\n\n";
    const after = "\n\n- id: after\n  config:\n    value: 42\n";
    const oldBlock = createDshManagedBlock({
      baseURL: "http://old",
      modelId: "old-model",
    });
    assert.deepStrictEqual(
      updateDshSettingsContent(`${before}${oldBlock}${after}`, block),
      { content: `${before}${block}${after}`, blockedByExistingLlmPiAi: false },
    );
  });

  test("replaces the managed block while preserving surrounding comments", () => {
    const before = "# before\n\n";
    const after = "\n\n# after\n";
    const oldBlock = createDshManagedBlock({
      baseURL: "http://old",
      modelId: "old-model",
    });
    assert.deepStrictEqual(
      updateDshSettingsContent(`${before}${oldBlock}${after}`, block),
      { content: `${before}${block}${after}`, blockedByExistingLlmPiAi: false },
    );
  });

  test("preserves CRLF when appending", () => {
    const original = "# desktop overrides\r\n# keep this comment\r\n";
    assert.deepStrictEqual(updateDshSettingsContent(original, block), {
      content: `${original}\r\n${block.replace(/\n/g, "\r\n")}\r\n`,
      blockedByExistingLlmPiAi: false,
    });
  });

  test("preserves CRLF when replacing a managed block", () => {
    const before = "# before\r\n\r\n";
    const after = "\r\n\r\n# after\r\n";
    const oldBlock = createDshManagedBlock({
      baseURL: "http://old",
      modelId: "old-model",
    });
    assert.deepStrictEqual(
      updateDshSettingsContent(
        `${before}${oldBlock.replace(/\n/g, "\r\n")}${after}`,
        block,
      ),
      {
        content: `${before}${block.replace(/\n/g, "\r\n")}${after}`,
        blockedByExistingLlmPiAi: false,
      },
    );
  });

  for (const newline of ["\n", "\r\n"]) {
    test(`repeated updates are idempotent with ${JSON.stringify(newline)} line endings`, () => {
      const original = `# keep${newline}# desktop overrides${newline}`;
      const first = updateDshSettingsContent(original, block);
      const second = updateDshSettingsContent(first.content, block);
      const third = updateDshSettingsContent(second.content, block);
      assert.strictEqual(first.blockedByExistingLlmPiAi, false);
      assert.deepStrictEqual(second, first);
      assert.deepStrictEqual(third, first);
      assert.strictEqual(
        first.content.split(DSH_MANAGED_BLOCK_START).length - 1,
        1,
      );
    });
  }

  const invalidMarkers = [
    {
      label: "orphaned start",
      content: `${DSH_MANAGED_BLOCK_START}\n- id: custom\n`,
    },
    {
      label: "orphaned end",
      content: `- id: custom\n${DSH_MANAGED_BLOCK_END}\n`,
    },
    {
      label: "reversed pair",
      content: `${DSH_MANAGED_BLOCK_END}\n${DSH_MANAGED_BLOCK_START}\n`,
    },
    { label: "duplicate blocks", content: `${block}\n${block}\n` },
    {
      label: "nested duplicate starts",
      content: `${DSH_MANAGED_BLOCK_START}\n${block}\n${DSH_MANAGED_BLOCK_END}\n`,
    },
    { label: "duplicate end", content: `${block}\n${DSH_MANAGED_BLOCK_END}\n` },
    {
      label: "indented start",
      content: `  ${DSH_MANAGED_BLOCK_START}\n${DSH_MANAGED_BLOCK_END}\n`,
    },
    {
      label: "indented end",
      content: `${DSH_MANAGED_BLOCK_START}\n  ${DSH_MANAGED_BLOCK_END}\n`,
    },
    {
      label: "embedded start",
      content: `# prefix ${DSH_MANAGED_BLOCK_START}\n`,
    },
    {
      label: "embedded end",
      content: `- id: custom\n  note: "${DSH_MANAGED_BLOCK_END}"\n`,
    },
    {
      label: "start with trailing text",
      content: `${DSH_MANAGED_BLOCK_START} extra\n${DSH_MANAGED_BLOCK_END}\n`,
    },
  ];

  for (const { label, content } of invalidMarkers) {
    test(`fails closed for ${label} markers`, () => {
      assertBlocked(content);
    });
  }

  const conflictingEntries = [
    "- id: llm-pi-ai\n  config: {}\n",
    '- id: "llm-pi-ai" # existing provider\n  config: {}\n',
    "- id: 'llm-pi-ai'\n  config: {}\n",
    "- id: agent-default-model\n  config: {}\n",
    '- id: "agent-default-model"\n  config: {}\n',
    "- id: 'agent-default-model'\n  config: {}\n",
    "- name: @deepseek-ai/dsh-llm-pi-ai\n  config: {}\n",
    '- name: "@deepseek-ai/dsh-agent-default-model"\n  config: {}\n',
    "- name: '@deepseek-ai/dsh-llm-pi-ai'\n  config: {}\n",
    '- id: custom\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config: {}\n',
    "- id: custom\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config: {}\n",
    '- name: "@example/custom"\n  id: "llm-pi-ai"\n  config: {}\n',
    "- name: '@example/custom'\n  id: 'agent-default-model'\n  config: {}\n",
  ];

  for (const [index, entry] of conflictingEntries.entries()) {
    test(`rejects an unmanaged provider/default-model identifier (${index + 1})`, () => {
      assertBlocked(entry);
    });

    test(`rejects a conflicting entry outside an existing managed block (${index + 1})`, () => {
      assertBlocked(`${entry}\n${block}\n`);
      assertBlocked(`${block}\n\n${entry}`);
    });
  }

  test("does not treat commented identifiers as executable entries", () => {
    const original = [
      "# - id: llm-pi-ai",
      '# name: "@deepseek-ai/dsh-agent-default-model"',
      "# - id: llm-pi-ai-custom",
      '#   name: "@example/custom"',
      "# - id: agent-default-model-custom",
      "",
    ].join("\n");
    assert.deepStrictEqual(updateDshSettingsContent(original, block), {
      content: `${original}\n${block}\n`,
      blockedByExistingLlmPiAi: false,
    });
  });

  const executableEntries = [
    { label: "unrelated plugin", content: "- id: custom\n  config: {}\n" },
    {
      label: "different provider id",
      content: "- id: llm-pi-ai-custom\n  config: {}\n",
    },
    {
      label: "escaped provider id",
      content: '- id: "llm\\u002dpi-ai"\n  config: {}\n',
    },
    {
      label: "escaped default model id",
      content: '- id: "agent\\u002ddefault-model"\n  config: {}\n',
    },
    {
      label: "flow plugin entry",
      content: '- {id: "llm-pi-ai", config: {}}\n',
    },
    {
      label: "anchored plugin entry",
      content: "- &provider\n  id: llm-pi-ai\n",
    },
    { label: "aliased plugin entry", content: "- *provider\n" },
    {
      label: "tagged plugin entry",
      content: "- !!map\n  id: agent-default-model\n",
    },
    { label: "merge alias", content: "- <<: *provider\n  config: {}\n" },
  ];

  for (const { label, content } of executableEntries) {
    test(`conservatively refuses ${label} without modifying content`, () => {
      assertBlocked(content);
      if (label === "unrelated plugin" || label === "different provider id") {
        for (const original of [
          `${content}\n${block}\n`,
          `${block}\n${content}`,
        ]) {
          assert.deepStrictEqual(updateDshSettingsContent(original, block), {
            content: original,
            blockedByExistingLlmPiAi: false,
          });
        }
      } else {
        assertBlocked(`${content}\n${block}\n`);
        assertBlocked(`${block}\n${content}`);
      }
    });
  }

  const invalidDocuments = [
    { label: "legacy mapping", content: "llm-pi-ai:\n  providers: {}\n" },
    { label: "unrelated mapping", content: "theme: dark\n" },
    { label: "quoted mapping", content: '"theme": dark\n' },
    { label: "flow mapping", content: "{theme: dark}\n" },
    { label: "nonempty flow array", content: '[{id: "custom"}]\n' },
    { label: "scalar document", content: "not-an-array\n" },
    {
      label: "mixed array and mapping",
      content: "- id: custom\nother: true\n",
    },
    { label: "document separator", content: "---\n- id: custom\n" },
    { label: "document terminator", content: "- id: custom\n...\n" },
    { label: "top-level block scalar", content: "|\n  not an array\n" },
    { label: "indented mapping", content: "  theme: dark\n" },
    { label: "unterminated flow sequence", content: "- id: [unterminated\n" },
    { label: "unterminated quoted scalar", content: '- id: "unterminated\n' },
    {
      label: "malformed nested mapping",
      content: "- id: custom\n  config: {broken\n",
    },
    { label: "empty array mixed with entries", content: "[]\n- id: custom\n" },
  ];

  for (const { label, content } of invalidDocuments) {
    test(`fails closed without modifying ${label} input`, () => {
      assertBlocked(content);
    });

    test(`fails closed for ${label} outside a managed block`, () => {
      assertBlocked(`${content}\n${block}\n`);
    });
  }
});
