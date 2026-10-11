import * as assert from "assert";

import {
  createDshManagedBlock,
  updateDshSettingsContent,
} from "../../utils/dshSettings";

suite("DSH patch conservative YAML safety", () => {
  const block = createDshManagedBlock({
    baseURL: "http://127.0.0.1:23333/api/openai/v1",
    modelId: "gpt-6.1-sol",
    modelContextWindow: 921793,
  });

  test("rejects an empty modality list", () => {
    assert.throws(() =>
      createDshManagedBlock({
        baseURL: "http://localhost/v1",
        modelId: "test",
        modelInput: [],
      }),
    );
  });

  test("preserves extra plugin entries inserted inside managed markers", () => {
    const edited = block.replace(
      "- id: agent-default-model",
      "- id: user-plugin\n  config: {}\n- id: agent-default-model",
    );
    assert.deepStrictEqual(updateDshSettingsContent(edited, block), {
      content: edited,
      blockedByExistingLlmPiAi: true,
    });
  });

  const unsupported = [
    {
      label: "JSON escaped provider identifier",
      content: '- id: "llm-pi-\\u0061i"\n  config: {}\n',
    },
    {
      label: "JSON escaped default-model identifier",
      content: '- id: "agent-default-\\u006dodel"\n  config: {}\n',
    },
    {
      label: "escaped identifier key",
      content: '- "\\u0069d": "llm-pi-ai"\n  config: {}\n',
    },
    {
      label: "escaped plugin name",
      content:
        '- id: custom\n  name: "@deepseek-ai/dsh-llm-pi-\\u0061i"\n  config: {}\n',
    },
    {
      label: "flow mapping array entry",
      content: "- {id: llm-pi-ai, config: {}}\n",
    },
    {
      label: "flow entry without whitespace after colon",
      content: '- {"id":"agent-default-model","config":{}}\n',
    },
    {
      label: "anchored provider identifier",
      content: "- id: &provider llm-pi-ai\n  config: {}\n",
    },
    {
      label: "tagged provider identifier",
      content: "- id: !!str llm-pi-ai\n  config: {}\n",
    },
    {
      label: "alias resolving to reserved provider identifier",
      content:
        "- id: other\n  config:\n    value: &provider llm-pi-ai\n- id: *provider\n  config: {}\n",
    },
    {
      label: "merged plugin identity",
      content: "- &entry\n  id: llm-pi-ai\n  config: {}\n- <<: *entry\n",
    },
    {
      label: "duplicate identity key",
      content: "- id: custom\n  id: llm-pi-ai\n  config: {}\n",
    },
    {
      label: "unsupported plugin key",
      content: "- id: custom\n  insert:\n    - id: llm-pi-ai\n",
    },
    {
      label: "scalar followed by indented mapping",
      content: "- id: other\n  config:\n    note: hello\n      id: llm-pi-ai\n",
    },
    {
      label: "tab-indented configuration",
      content: "- id: other\n\tconfig: {}\n",
    },
    {
      label: "configuration block scalar",
      content: "- id: other\n  config:\n    note: |\n      id: llm-pi-ai\n",
    },
    {
      label: "non-JSON YAML escape",
      content: '- id: "llm-pi-\\x61i"\n  config: {}\n',
    },
  ];

  for (const { label, content } of unsupported) {
    for (const managed of [false, true]) {
      test(`refuses ${label}${managed ? " outside a managed block" : ""} without modifying content`, () => {
        const original = managed ? `${content}\n${block}\n` : content;
        assert.deepStrictEqual(updateDshSettingsContent(original, block), {
          content: original,
          blockedByExistingLlmPiAi: true,
        });
      });
    }
  }

  test("refuses automatic mutation of unrelated UI plugins and preserves their bytes", () => {
    const original =
      '# display settings\n- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n  config:\n    transcriptView: standard\n    performanceUsage: detailed\n';
    assert.deepStrictEqual(updateDshSettingsContent(original, block), {
      content: original,
      blockedByExistingLlmPiAi: true,
    });
  });
});
