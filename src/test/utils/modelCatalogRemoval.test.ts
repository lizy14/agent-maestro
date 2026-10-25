import * as assert from "assert";
import * as fs from "fs";
import os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { createDshManagedBlock } from "../../utils/dshSettings";
import { logger } from "../../utils/logger";
import {
  ModelRemovalMonitor,
  REMOVAL_CONFIRM_DELAY_MS,
  REMOVAL_INVENTORY_KEY,
  inventoryRemovalBlock,
  modelInventory,
  newerSeriesModel,
  planCatalogRemoval,
  removalConfidence,
  removeCatalogModels,
} from "../../utils/modelCatalogRemoval";
import { CatalogTarget, modelToDshConfig } from "../../utils/modelCatalogs";
import { modelRouteId } from "../../utils/modelIdentity";

suite("Optional unavailable model catalog removal", () => {
  const model = (id: string, vendor = "copilot") =>
    ({
      id,
      vendor,
      name: `Model ${id}`,
      family: "gpt",
      version: "1",
      maxInputTokens: 128000,
    }) as vscode.LanguageModelChat;
  const models = (count = 6, vendor = "copilot") =>
    Array.from({ length: count }, (_, i) => model(`m${i}`, vendor));
  const target: CatalogTarget = {
    path: "unused-generated.patch.yml",
    kind: "dsh",
  };
  const generated = (items = models(), defaultId = items[0].id) =>
    createDshManagedBlock({
      baseURL: "http://127.0.0.1:23333/api/openai/v1/",
      modelId: defaultId,
      models: items.map(modelToDshConfig),
    });
  const absent = (...ids: string[]) => new Set(ids);
  const buddyRow = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `Model ${id} (Agent Maestro)`,
    url: "http://127.0.0.1:23333/api/openai/v1/chat/completions",
    apiKey: "test-placeholder",
    ...extra,
  });
  const buddy = (
    extra: Record<string, unknown> = {},
    rows = models(8).map((item) => buddyRow(item.id)),
  ) => JSON.stringify({ models: rows, ...extra });
  const buddyTarget: CatalogTarget = {
    path: "unused-models.json",
    kind: "workbuddy",
  };

  test("newer same-series heuristics require matching vendor and suffix", () => {
    const old = modelInventory([model("gpt-5.5")])[0];
    assert.ok(newerSeriesModel(old, modelInventory([model("gpt-5.6")])));
    assert.strictEqual(
      newerSeriesModel(old, modelInventory([model("gpt-5.6-mini")])),
      undefined,
    );
    assert.strictEqual(
      newerSeriesModel(old, modelInventory([model("gpt-5.6", "other")])),
      undefined,
    );
    assert.strictEqual(
      newerSeriesModel(old, modelInventory([model("gpt-5.4")])),
      undefined,
    );
    assert.strictEqual(
      newerSeriesModel(
        modelInventory([model("copilot-utility-1")])[0],
        modelInventory([model("copilot-utility-2")]),
      ),
      undefined,
    );
  });
  test("confidence increases with spaced persistence and a same-series successor", () => {
    const successor = modelInventory([model("gpt-5.6")])[0];
    assert.strictEqual(
      removalConfidence(
        { since: 0, lastSeenMissing: 30000, observations: 2 },
        undefined,
        30000,
      ).eligible,
      false,
    );
    assert.strictEqual(
      removalConfidence(
        { since: 0, lastSeenMissing: 30000, observations: 2 },
        successor,
        30000,
      ).eligible,
      true,
    );
    assert.strictEqual(
      removalConfidence(
        { since: 0, lastSeenMissing: 300000, observations: 3 },
        undefined,
        300000,
      ).eligible,
      true,
    );
    assert.strictEqual(
      removalConfidence(
        { since: 0, lastSeenMissing: 300000, observations: 1 },
        undefined,
        300000,
      ).eligible,
      false,
    );
  });

  test("empty current inventory blocks removal even without an earlier baseline", () => {
    assert.ok(inventoryRemovalBlock([], []));
    assert.ok(inventoryRemovalBlock(modelInventory(models()), []));
  });
  test("loss of exactly half or more of the global inventory blocks removal", () => {
    const before = modelInventory(models());
    assert.match(inventoryRemovalBlock(before, before.slice(0, 3))!, /half/);
    assert.match(inventoryRemovalBlock(before, before.slice(0, 2))!, /half/);
  });
  test("a disappeared provider blocks removal despite modest global loss", () => {
    const before = modelInventory([...models(8), ...models(2, "other")]);
    assert.match(
      inventoryRemovalBlock(before, modelInventory(models(8)))!,
      /Provider other/,
    );
  });
  test("loss of exactly half of one provider blocks removal", () => {
    const before = modelInventory([...models(8), ...models(4, "other")]);
    const now = modelInventory([...models(8), ...models(2, "other")]);
    assert.match(inventoryRemovalBlock(before, now)!, /Provider other/);
  });
  test("healthy modest loss and first nonempty baseline permit inspection", () => {
    assert.strictEqual(
      inventoryRemovalBlock([], modelInventory(models())),
      undefined,
    );
    assert.strictEqual(
      inventoryRemovalBlock(
        modelInventory(models()),
        modelInventory(models().filter((item) => item.id !== "m1")),
      ),
      undefined,
    );
  });
  test("inventory deduplicates provider identities but preserves equal IDs across vendors", () => {
    const items = [model("same"), model("same"), model("same", "other")];
    const inventory = modelInventory(items);
    assert.strictEqual(inventory.length, 2);
    assert.strictEqual(new Set(inventory.map((item) => item.routeId)).size, 2);
  });

  test("DSH plan protects the current default", () => {
    const plan = planCatalogRemoval(target, generated(), absent("m0", "m1"));
    assert.deepStrictEqual(
      plan.candidates.map((row) => row.id),
      ["m1"],
    );
    assert.ok(!plan.blockedReason);
  });
  test("duplicate names cannot make a custom DSH row removable", () => {
    const content = generated().replace(
      'name: "Model m1 (Agent Maestro)"',
      'name: "Model m1 (Agent Maestro)"\n            name: "Custom label"',
    );
    assert.throws(
      () => planCatalogRemoval(target, content, absent("m1")),
      /Duplicate/,
    );
  });
  test("DSH block-sequence references protect stale rows", () => {
    const content = `${generated()}\n- id: other-plugin\n  config:\n    fallbackModels:\n      - "m1"\n`;
    assert.deepStrictEqual(
      planCatalogRemoval(target, content, absent("m1")).candidates,
      [],
    );
  });
  test("1M default suffix protects underlying route", () => {
    const content = generated().replace('model: "m0"', 'model: "m1[1m]"');
    assert.deepStrictEqual(
      planCatalogRemoval(target, content, absent("m1")).candidates,
      [],
    );
  });

  test("DSH plan protects unnamed and custom-labeled entries", () => {
    const original = generated()
      .replace('            name: "Model m1 (Agent Maestro)"\n', "")
      .replace('name: "Model m2 (Agent Maestro)"', 'name: "My custom model"');
    const plan = planCatalogRemoval(target, original, absent("m1", "m2"));
    assert.deepStrictEqual(plan.candidates, []);
  });
  for (const newline of ["\n", "\r\n"]) {
    test(`DSH removes only the selected stale stanza and preserves UI/defaults (${JSON.stringify(newline)})`, () => {
      const ui =
        '\n- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n  config:\n    performanceUsage: detailed\n';
      const original = `${generated()}${ui}`.replace(/\n/g, newline);
      const plan = planCatalogRemoval(target, original, absent("m1", "m2"));
      assert.deepStrictEqual(
        plan.candidates.map((row) => row.id),
        ["m1", "m2"],
      );
      const result = removeCatalogModels(
        plan,
        absent("m1", "m0", "not-in-plan"),
      );
      const exactStanza =
        '          - id: "m1"\n            name: "Model m1 (Agent Maestro)"\n            contextWindow: 128000\n            input:\n              - text\n'.replace(
          /\n/g,
          newline,
        );
      assert.ok(original.includes(exactStanza));
      assert.strictEqual(result, original.replace(exactStanza, ""));
      assert.ok(result.includes('    model: "m0"'));
      assert.ok(result.endsWith(ui.replace(/\n/g, newline)));
      if (newline === "\r\n") {
        assert.ok(!/(?<!\r)\n/.test(result));
      }
    });
  }
  test("DSH removal is route-exact for same raw model IDs across providers", () => {
    const items = [...models(), model("m1", "other")];
    const qualified = modelRouteId(items.at(-1)!);
    const original = generated(items);
    const plan = planCatalogRemoval(target, original, absent(qualified));
    const result = removeCatalogModels(plan, absent(qualified));
    assert.ok(result.includes('- id: "m1"'));
    assert.ok(!result.includes(JSON.stringify(qualified)));
  });
  test("half a DSH catalog cannot be selected for removal", () => {
    const plan = planCatalogRemoval(
      target,
      generated(),
      absent("m1", "m2", "m3"),
    );
    assert.match(plan.blockedReason!, /half/);
    assert.deepStrictEqual(plan.candidates, []);
    assert.throws(() => removeCatalogModels(plan, absent("m1")), /half/);
  });
  test("a last remaining catalog entry is never removed", () => {
    const plan = planCatalogRemoval(
      target,
      generated([model("only")]),
      absent("only"),
    );
    assert.ok(plan.blockedReason);
    assert.throws(() => removeCatalogModels(plan, absent("only")));
  });
  test("unselected and unrelated IDs produce no changes", () => {
    const original = generated();
    const plan = planCatalogRemoval(target, original, absent("m1"));
    assert.strictEqual(removeCatalogModels(plan, absent()), original);
    assert.strictEqual(
      removeCatalogModels(plan, absent("m0", "m5", "unknown")),
      original,
    );
  });
  test("Buddy protects default, relatedModels and availableModels references", () => {
    const original = buddy(
      { defaultModel: "m1", availableModels: ["m3"], keep: true },
      models(8).map((item) =>
        buddyRow(
          item.id,
          item.id === "m7" ? { relatedModels: { helper: "m2" } } : {},
        ),
      ),
    );
    const plan = planCatalogRemoval(
      buddyTarget,
      original,
      absent("m1", "m2", "m3"),
    );
    assert.deepStrictEqual(plan.candidates, []);
    assert.strictEqual(
      removeCatalogModels(plan, absent("m1", "m2", "m3")),
      original,
    );
  });
  test("Buddy preserves custom labels and non-Maestro endpoints", () => {
    const rows = models(8).map((item) => buddyRow(item.id));
    rows[1] = buddyRow("m1", { name: "Personal custom model" });
    rows[2] = buddyRow("m2", {
      url: "https://example.invalid/v1/chat/completions",
    });
    const plan = planCatalogRemoval(
      buddyTarget,
      buddy({}, rows),
      absent("m1", "m2"),
    );
    assert.deepStrictEqual(plan.candidates, []);
  });
  test("Buddy removes only selected stale owned models retaining custom fields and credentials", () => {
    const original = buddy({ defaultModel: "m0", custom: { mode: "keep" } });
    const plan = planCatalogRemoval(buddyTarget, original, absent("m1", "m2"));
    const updated = JSON.parse(removeCatalogModels(plan, absent("m1")));
    const expected = JSON.parse(original);
    expected.models = expected.models.filter(
      (row: { id: string }) => row.id !== "m1",
    );
    assert.deepStrictEqual(updated, expected);
  });
  test("Buddy half-catalog loss blocks destructive updates", () => {
    const plan = planCatalogRemoval(
      buddyTarget,
      buddy(),
      absent("m1", "m2", "m3", "m4"),
    );
    assert.ok(plan.blockedReason);
    assert.deepStrictEqual(plan.candidates, []);
  });
  test("unmanaged DSH YAML and duplicate Buddy IDs are rejected", () => {
    assert.throws(() =>
      planCatalogRemoval(
        target,
        "- id: llm-pi-ai\n  config:\n    providers:\n      agent-maestro:\n        apiKeyEnv: AGENT_MAESTRO_API_KEY\n        models: []\n",
        absent("m1"),
      ),
    );
    assert.throws(() =>
      planCatalogRemoval(
        buddyTarget,
        buddy({}, [buddyRow("same"), buddyRow("same")]),
        absent("same"),
      ),
    );
  });

  suite("Removal monitor safeguards", () => {
    const restorers: (() => void)[] = [];
    let root: string;
    let previousHome: string | undefined;
    let state: Map<string, unknown>;
    let context: vscode.ExtensionContext;
    let now: number;
    let prompts: number;
    let schedules: number;
    let selectedCalls: number;
    let pathToCatalog: string;
    const mock = (object: object, key: string, value: unknown) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      Object.defineProperty(object, key, {
        configurable: true,
        writable: true,
        value,
      });
      restorers.push(() =>
        descriptor
          ? Object.defineProperty(object, key, descriptor)
          : Reflect.deleteProperty(object, key),
      );
    };
    setup(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "am-catalog-removal-"));
      previousHome = process.env.DSH_HOME;
      process.env.DSH_HOME = root;
      pathToCatalog = path.join(
        root,
        "profiles",
        "desktop",
        "cordis.patch.yml",
      );
      fs.mkdirSync(path.dirname(pathToCatalog), { recursive: true });
      fs.writeFileSync(pathToCatalog, `${generated()}\n`);
      state = new Map();
      now = 1000;
      prompts = 0;
      schedules = 0;
      selectedCalls = 0;
      context = {
        subscriptions: [],
        globalState: {
          get: (key: string, fallback?: unknown) =>
            state.has(key) ? state.get(key) : fallback,
          update: async (key: string, value: unknown) => {
            state.set(key, value);
          },
        },
      } as unknown as vscode.ExtensionContext;
      mock(os, "homedir", () => root);
      mock(vscode.workspace, "workspaceFolders", []);
      mock(vscode.workspace, "textDocuments", []);
      mock(logger, "warn", () => undefined);
      mock(logger, "debug", () => undefined);
      mock(vscode.window, "showInformationMessage", async () => {
        prompts++;
        return "Keep entries";
      });
      mock(
        vscode.window,
        "showQuickPick",
        async (options: { id: string }[]) => {
          selectedCalls++;
          return options.filter((option) => option.id === "m1");
        },
      );
      mock(
        vscode.window,
        "showWarningMessage",
        async () => "Remove selected entries",
      );
    });
    teardown(() => {
      while (restorers.length) {
        restorers.pop()!();
      }
      if (previousHome === undefined) {
        delete process.env.DSH_HOME;
      } else {
        process.env.DSH_HOME = previousHome;
      }
      assert.strictEqual(path.dirname(root), os.tmpdir());
      assert.ok(path.basename(root).startsWith("am-catalog-removal-"));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const check = (
      monitor: ModelRemovalMonitor,
      current: vscode.LanguageModelChat[],
    ) =>
      monitor.check(
        current,
        () => {
          schedules++;
        },
        () => false,
      );
    const live = () => models().filter((item) => item.id !== "m1");
    test("first healthy inventory establishes a baseline without suggesting stale configured rows", async () => {
      const monitor = new ModelRemovalMonitor(context, () => now);
      const before = fs.readFileSync(pathToCatalog, "utf8");
      await check(monitor, live());
      assert.strictEqual(prompts, 0);
      assert.strictEqual(schedules, 0);
      assert.deepStrictEqual(
        state.get(REMOVAL_INVENTORY_KEY),
        modelInventory(live()),
      );
      assert.strictEqual(fs.readFileSync(pathToCatalog, "utf8"), before);
    });
    test("modest loss waits the full delay and schedules another observation", async () => {
      const monitor = new ModelRemovalMonitor(context, () => now);
      await check(monitor, models());
      await check(monitor, live());
      assert.strictEqual(prompts, 0);
      assert.strictEqual(schedules, 1);
      now += REMOVAL_CONFIRM_DELAY_MS - 1;
      await check(monitor, live());
      assert.strictEqual(prompts, 0);
      now++;
      await check(monitor, live());
      assert.strictEqual(prompts, 0);
      now += 5 * 60 * 1000;
      await check(monitor, live());
      assert.strictEqual(prompts, 1);
      assert.strictEqual(selectedCalls, 0);
      await check(monitor, live());
      assert.strictEqual(prompts, 1);
    });
    for (const scenario of ["zero", "mass"] as const) {
      test(`${scenario} inventory does not prompt or rewrite the healthy baseline`, async () => {
        const monitor = new ModelRemovalMonitor(context, () => now);
        await check(monitor, models());
        const original = fs.readFileSync(pathToCatalog, "utf8");
        await check(monitor, scenario === "zero" ? [] : models().slice(0, 3));
        now += REMOVAL_CONFIRM_DELAY_MS * 2;
        await check(monitor, scenario === "zero" ? [] : models().slice(0, 3));
        assert.strictEqual(prompts, 0);
        assert.deepStrictEqual(
          state.get(REMOVAL_INVENTORY_KEY),
          modelInventory(models()),
        );
        assert.strictEqual(fs.readFileSync(pathToCatalog, "utf8"), original);
      });
    }
    test("reappeared selected model is kept by the final inventory query", async () => {
      const monitor = new ModelRemovalMonitor(context, () => now);
      const original = fs.readFileSync(pathToCatalog, "utf8");
      mock(vscode.window, "showInformationMessage", async (message: string) =>
        message.startsWith("Previously")
          ? "Review unavailable models"
          : undefined,
      );
      let finalQueries = 0;
      mock(vscode.lm, "selectChatModels", async () => {
        finalQueries++;
        return models();
      });
      await check(monitor, models());
      await check(monitor, live());
      now += REMOVAL_CONFIRM_DELAY_MS;
      await check(monitor, live());
      now += 5 * 60 * 1000;
      await check(monitor, live());
      assert.strictEqual(selectedCalls, 1);
      assert.strictEqual(finalQueries, 1);
      assert.strictEqual(fs.readFileSync(pathToCatalog, "utf8"), original);
      assert.strictEqual(fs.readdirSync(path.dirname(pathToCatalog)).length, 1);
    });
    test("confirmed persistent loss removes one selected entry with an original backup", async () => {
      const monitor = new ModelRemovalMonitor(context, () => now);
      const original = fs.readFileSync(pathToCatalog, "utf8");
      mock(vscode.window, "showInformationMessage", async (message: string) =>
        message.startsWith("Previously")
          ? "Review unavailable models"
          : undefined,
      );
      mock(vscode.lm, "selectChatModels", async () => live());
      await check(monitor, models());
      await check(monitor, live());
      now += REMOVAL_CONFIRM_DELAY_MS;
      await check(monitor, live());
      now += 5 * 60 * 1000;
      await check(monitor, live());
      assert.ok(!fs.readFileSync(pathToCatalog, "utf8").includes('- id: "m1"'));
      assert.ok(fs.readFileSync(pathToCatalog, "utf8").includes('model: "m0"'));
      const backups = fs
        .readdirSync(path.dirname(pathToCatalog))
        .filter((name) => name.endsWith(".bak"));
      assert.strictEqual(backups.length, 1);
      assert.strictEqual(
        fs.readFileSync(
          path.join(path.dirname(pathToCatalog), backups[0]),
          "utf8",
        ),
        original,
      );
    });
  });
});
