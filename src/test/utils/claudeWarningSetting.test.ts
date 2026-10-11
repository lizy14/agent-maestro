import * as assert from "assert";
import * as vscode from "vscode";

import {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  readConfiguration,
} from "../../utils/config";

suite("Missing Claude warning setting", () => {
  test("suppression is opt-in and uses application-level setting key", () => {
    assert.strictEqual(DEFAULT_CONFIG.suppressNoClaudeModelsWarning, false);
    assert.strictEqual(
      CONFIG_KEYS.SUPPRESS_NO_CLAUDE_MODELS_WARNING,
      "agent-maestro.suppressNoClaudeModelsWarning",
    );
  });
  test("reads suppression from current VS Code configuration", () => {
    const original = vscode.workspace.getConfiguration;
    try {
      (vscode.workspace as any).getConfiguration = () => ({
        get: (key: string, fallback: unknown) =>
          key === CONFIG_KEYS.SUPPRESS_NO_CLAUDE_MODELS_WARNING
            ? true
            : fallback,
      });
      assert.strictEqual(
        readConfiguration().suppressNoClaudeModelsWarning,
        true,
      );
    } finally {
      (vscode.workspace as any).getConfiguration = original;
    }
  });
});
