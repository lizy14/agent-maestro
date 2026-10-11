import * as assert from "assert";
import * as vscode from "vscode";

import { createDshManagedBlock } from "../../utils/dshSettings";
import { appendCatalogModels } from "../../utils/modelCatalogs";
import {
  modelDisplayName,
  modelNotificationLabel,
} from "../../utils/modelIdentity";

suite("Distinct model display names", () => {
  const make = (id: string, name = "GPT-5.6 Luna", vendor = "copilot") =>
    ({ id, name, vendor, maxInputTokens: 921793 }) as vscode.LanguageModelChat;
  test("keeps normal models concise and distinguishes dictation aliases", () => {
    assert.strictEqual(
      modelDisplayName(make("gpt-5.6-luna")),
      "GPT-5.6 Luna (Agent Maestro)",
    );
    assert.strictEqual(
      modelDisplayName(make("copilot-dictation-cleanup-luna")),
      "GPT-5.6 Luna [internal alias: copilot-dictation-cleanup-luna] (Agent Maestro)",
    );
  });
  test("distinguishes utility aliases and provider variants", () => {
    assert.ok(
      modelDisplayName(make("copilot-utility-small", "GPT-4o mini")).includes(
        "copilot-utility-small",
      ),
    );
    assert.ok(
      modelDisplayName(make("gpt-5.6-luna", undefined, "copilotcli")).includes(
        "copilotcli: gpt-5.6-luna",
      ),
    );
  });
  test("notification includes exact ID even for identical names", () => {
    assert.strictEqual(
      modelNotificationLabel(make("copilot-dictation-cleanup-luna")),
      "GPT-5.6 Luna [copilot / copilot-dictation-cleanup-luna]",
    );
  });
  test("DSH already containing an alias remains byte-for-byte unchanged", () => {
    const item = make("copilot-dictation-cleanup-luna");
    const content = createDshManagedBlock({
      baseURL: "http://localhost/v1",
      modelId: item.id,
      models: [{ modelId: item.id }],
    });
    assert.strictEqual(
      appendCatalogModels({ path: "unused", kind: "dsh" }, content, [item]),
      content,
    );
  });
});
