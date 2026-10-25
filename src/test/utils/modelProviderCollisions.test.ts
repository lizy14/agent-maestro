import * as assert from "assert";
import * as vscode from "vscode";

import {
  createAnthropicModelsResponse,
  findAnthropicModelById,
} from "../../server/utils/anthropicModels";
import {
  chatModelsCache,
  getChatModelClient,
  getChatModelsQuickPickItems,
} from "../../utils/chatModels";
import {
  anthropicModelRouteId,
  isQualifiedModelId,
  modelRouteId,
  resolveQualifiedModel,
} from "../../utils/modelIdentity";

suite("Provider model identity collisions", () => {
  const model = (
    vendor: string,
    id: string,
    family = "claude",
    name = id,
  ): vscode.LanguageModelChat =>
    ({
      vendor,
      id,
      family,
      name,
      version: "1",
      maxInputTokens: 128000,
    }) as vscode.LanguageModelChat;
  let restore: (() => void) | undefined;
  function inventory(models: vscode.LanguageModelChat[]): void {
    const descriptor = Object.getOwnPropertyDescriptor(
      chatModelsCache,
      "getChatModels",
    );
    Object.defineProperty(chatModelsCache, "getChatModels", {
      configurable: true,
      writable: true,
      value: async () => models,
    });
    restore = () => {
      if (descriptor) {
        Object.defineProperty(chatModelsCache, "getChatModels", descriptor);
      } else {
        Reflect.deleteProperty(chatModelsCache, "getChatModels");
      }
    };
  }
  teardown(() => {
    restore?.();
    restore = undefined;
  });

  for (const order of ["copilot-first", "copilot-last"] as const) {
    test(`recommendation prefers Copilot without dropping same-ID variants (${order})`, async () => {
      const copilot = model("copilot", "gpt-5.5", "gpt");
      const other = model("other", "gpt-5.5", "gpt");
      const third = model("third", "gpt-5.5", "gpt");
      const rest = model("copilot", "gpt-another", "gpt");
      inventory(
        order === "copilot-first"
          ? [copilot, other, third, rest]
          : [third, other, rest, copilot],
      );
      const rows = (
        await getChatModelsQuickPickItems({ recommendedModelId: "gpt-5.5" })
      ).filter((item) => item.modelId);
      assert.strictEqual(rows[0].modelId, "gpt-5.5");
      assert.deepStrictEqual(
        new Set(rows.map((item) => item.modelId)),
        new Set([copilot, other, third, rest].map(modelRouteId)),
      );
      assert.strictEqual(rows.length, 4);
    });
  }

  test("qualified recommendation selects its provider rather than the raw-ID Copilot row", async () => {
    const copilot = model("copilot", "gpt-5.5", "gpt");
    const other = model("other", "gpt-5.5", "gpt");
    inventory([copilot, other]);
    const rows = (
      await getChatModelsQuickPickItems({
        recommendedModelId: modelRouteId(other),
      })
    ).filter((item) => item.modelId);
    assert.deepStrictEqual(
      rows.map((item) => item.modelId),
      [modelRouteId(other), modelRouteId(copilot)],
    );
  });

  test("qualified recommendation cannot be captured by a raw-ID lookalike", async () => {
    const other = model("other", "gpt-5.5", "gpt");
    const rawLookalike = model("copilot", modelRouteId(other), "gpt");
    inventory([rawLookalike, other]);
    const rows = (
      await getChatModelsQuickPickItems({
        recommendedModelId: modelRouteId(other),
      })
    ).filter((item) => item.modelId);
    assert.strictEqual(rows[0].modelId, modelRouteId(other));
    assert.strictEqual(rows.length, 2);
  });

  test("recommendation is deterministic without Copilot and deduplicates repeated identities", async () => {
    const alpha = model("alpha", "gpt-5.5", "gpt");
    const zebra = model("zebra", "gpt-5.5", "gpt");
    inventory([zebra, alpha, alpha]);
    const rows = (
      await getChatModelsQuickPickItems({ recommendedModelId: "gpt-5.5" })
    ).filter((item) => item.modelId);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].modelId, modelRouteId(alpha));
  });

  test("advertised Claude models have unique discoverable IDs and roundtrip to their actual provider", async () => {
    const models = [
      model("copilot", "claude-shared"),
      model("other", "claude-shared"),
      model("third", "claude-shared"),
      model("catalog-provider", "opaque-123", "claude", "Claude Opaque"),
      model("copilot", "opaque-copilot", "claude", "Claude Copilot Opaque"),
    ];
    inventory(models);
    const listing = createAnthropicModelsResponse(models);
    assert.strictEqual(listing.data.length, models.length);
    assert.strictEqual(
      new Set(listing.data.map((row) => row.id)).size,
      models.length,
    );
    assert.strictEqual(listing.data[0].id, "claude-shared");
    for (let i = 0; i < listing.data.length; i++) {
      const advertised = listing.data[i];
      assert.match(advertised.id, /claude|anthropic/i);
      assert.ok(!/[/:]/.test(advertised.id));
      assert.strictEqual(
        (await getChatModelClient(advertised.id)).client,
        models[i],
      );
      assert.strictEqual(
        findAnthropicModelById(models, advertised.id)?.id,
        advertised.id,
      );
      assert.strictEqual(
        findAnthropicModelById(models, advertised.id)?.display_name,
        models[i].name,
      );
    }
    assert.strictEqual(listing.first_id, listing.data[0].id);
    assert.strictEqual(listing.last_id, listing.data.at(-1)?.id);
  });

  test("old DSH/Buddy qualified IDs remain unchanged and resolvable alongside Anthropic aliases", async () => {
    const item = model("other", "claude-shared");
    const existing = modelRouteId(item);
    inventory([item]);
    const wire = anthropicModelRouteId(item);
    assert.strictEqual(wire, `anthropic-${existing}`);
    assert.strictEqual(modelRouteId(item), existing);
    for (const id of [existing, `${existing}[1m]`, wire, `${wire}[1m]`]) {
      assert.ok(isQualifiedModelId(id));
      assert.strictEqual(resolveQualifiedModel(id, [item]), item);
      assert.strictEqual((await getChatModelClient(id)).client, item);
      assert.strictEqual(findAnthropicModelById([item], id)?.id, wire);
    }
  });

  test("unknown qualified Anthropic aliases fail rather than fuzzy-match or use fallback", async () => {
    const existing = model("copilot", "claude-known");
    const gone = model("other", "claude-known");
    inventory([existing]);
    for (const id of [
      anthropicModelRouteId(gone),
      "anthropic-vscode-lm-malformed",
      "anthropic-vscode-lm-",
      `${anthropicModelRouteId(gone)}[1m]`,
    ]) {
      assert.ok(isQualifiedModelId(id));
      const result = await getChatModelClient(id);
      assert.ok(result.error);
      assert.strictEqual(result.client, undefined);
      assert.strictEqual(findAnthropicModelById([existing], id), null);
    }
  });

  test("retrieval of a raw duplicate without Copilot is ambiguous instead of provider-order dependent", async () => {
    const models = [
      model("first", "claude-shared"),
      model("second", "claude-shared"),
    ];
    inventory(models);
    assert.strictEqual(findAnthropicModelById(models, "claude-shared"), null);
    assert.ok((await getChatModelClient("claude-shared")).error);
    for (const item of createAnthropicModelsResponse(models).data) {
      assert.ok((await getChatModelClient(item.id)).client);
    }
  });

  test("repeated identical provider entries do not duplicate Anthropic rows; non-Claude models stay excluded", () => {
    const item = model("other", "claude-shared");
    const listing = createAnthropicModelsResponse([
      item,
      item,
      model("copilot", "gpt-5.5", "gpt"),
    ]);
    assert.strictEqual(listing.data.length, 1);
    assert.strictEqual(findAnthropicModelById([item], "not-a-model"), null);
  });

  test("reserved alias-looking Copilot IDs cannot collide with non-Copilot Anthropic aliases", async () => {
    const other = model("other", "claude-shared");
    const reserved = model("copilot", anthropicModelRouteId(other));
    inventory([other, reserved]);
    assert.notStrictEqual(modelRouteId(other), modelRouteId(reserved));
    assert.strictEqual(
      (await getChatModelClient(modelRouteId(reserved))).client,
      reserved,
    );
    assert.strictEqual(
      (await getChatModelClient(modelRouteId(other))).client,
      other,
    );
    const listing = createAnthropicModelsResponse([other, reserved]);
    assert.strictEqual(new Set(listing.data.map((item) => item.id)).size, 2);
    for (let i = 0; i < listing.data.length; i++) {
      assert.strictEqual(
        (await getChatModelClient(listing.data[i].id)).client,
        [other, reserved][i],
      );
    }
  });
});
