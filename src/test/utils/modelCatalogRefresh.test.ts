import * as assert from "assert";
import * as fs from "fs";
import os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { chatModelsCache, getChatModelClient } from "../../utils/chatModels";
import { createDshManagedBlock } from "../../utils/dshSettings";
import { logger } from "../../utils/logger";
import {
  MODEL_SNAPSHOT_KEY,
  modelIdentity,
  registerModelCatalogWatcher,
} from "../../utils/modelCatalogWatcher";
import {
  CATALOG_TARGETS_KEY,
  CatalogTarget,
  appendCatalogModels,
  findCatalogTargets,
  hasPopulatedCatalog,
  modelToDshConfig,
  rememberCatalogTargets,
  writeCatalogUpdate,
} from "../../utils/modelCatalogs";
import {
  isQualifiedModelId,
  modelRouteId,
  resolveQualifiedModel,
} from "../../utils/modelIdentity";

suite("Model catalog refresh", () => {
  type RuntimeModel = vscode.LanguageModelChat & {
    maxOutputTokens?: number;
    capabilities?: {
      imageInput?: boolean;
      supportsImageToText?: boolean;
      toolCalling?: boolean | number;
      supportsToolCalling?: boolean;
    };
  };
  const model = (
    id: string,
    vendor = "copilot",
    extra: Partial<RuntimeModel> = {},
  ): RuntimeModel =>
    ({
      id,
      vendor,
      name: id,
      family: "gpt",
      version: "1",
      maxInputTokens: 921793,
      ...extra,
    }) as RuntimeModel;
  const restorers: (() => void)[] = [];
  let root: string;
  let oldHome: string | undefined;
  let state: Map<string, unknown>;
  let context: vscode.ExtensionContext;
  let watchers: vscode.Disposable[];
  function mock(target: object, key: string, value: unknown): void {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value,
    });
    restorers.push(() =>
      original
        ? Object.defineProperty(target, key, original)
        : Reflect.deleteProperty(target, key),
    );
  }
  function file(
    name: string,
    content: string,
    kind: CatalogTarget["kind"] = "dsh",
  ): CatalogTarget {
    const target = { path: path.join(root, name), kind };
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    fs.writeFileSync(target.path, content);
    return target;
  }
  function block(): string {
    return createDshManagedBlock({
      baseURL: "http://localhost:24567/api/openai/v1/",
      modelId: "old",
      models: [modelToDshConfig(model("old"))],
    });
  }
  const read = (target: CatalogTarget) => fs.readFileSync(target.path, "utf8");
  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "am-catalog-refresh-"));
    oldHome = process.env.DSH_HOME;
    process.env.DSH_HOME = root;
    state = new Map();
    watchers = [];
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
  });
  teardown(() => {
    watchers.forEach((watcher) => watcher.dispose());
    while (restorers.length) {
      restorers.pop()!();
    }
    if (oldHome === undefined) {
      delete process.env.DSH_HOME;
    } else {
      process.env.DSH_HOME = oldHome;
    }
    assert.strictEqual(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("am-catalog-refresh-"));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("keeps Copilot routes bare but namespaces same-id vendors without collisions", () => {
    const copilot = model("shared");
    const other = model("shared", "other");
    const cli = model("shared", "copilotcli");
    assert.strictEqual(modelRouteId(copilot), "shared");
    assert.strictEqual(
      new Set([copilot, other, cli].map(modelRouteId)).size,
      3,
    );
    assert.strictEqual(
      resolveQualifiedModel(modelRouteId(other), [copilot, other, cli]),
      other,
    );
    assert.strictEqual(resolveQualifiedModel("shared", [copilot]), undefined);
    assert.ok(isQualifiedModelId(modelRouteId(cli)));
    assert.strictEqual(isQualifiedModelId("shared"), false);
  });
  test("escapes namespace punctuation and protects Copilot ids that resemble qualified routes", () => {
    const item = model('vscode-lm-weird/"id', 'vendor: /"unicode-汉');
    assert.strictEqual(resolveQualifiedModel(modelRouteId(item), [item]), item);
    assert.strictEqual(
      resolveQualifiedModel(`${modelRouteId(item)}[1m]`, [item]),
      item,
    );
    assert.ok(!/[/:]/.test(modelRouteId(item)));
    const reserved = model(modelRouteId(item));
    assert.notStrictEqual(modelRouteId(reserved), modelRouteId(item));
    assert.strictEqual(
      resolveQualifiedModel("vscode-lm-malformed", [item]),
      undefined,
    );
    assert.notStrictEqual(modelIdentity(item), modelIdentity(reserved));
  });
  test("routes qualified same-ID providers exactly and refuses unavailable or ambiguous routes", async () => {
    const copilot = model("shared");
    const other = model("shared", "other");
    mock(chatModelsCache, "getChatModels", async () => [copilot, other]);
    assert.strictEqual((await getChatModelClient("shared")).client, copilot);
    assert.strictEqual(
      (await getChatModelClient(modelRouteId(other))).client,
      other,
    );
    assert.strictEqual(
      (await getChatModelClient(`${modelRouteId(other)}[1m]`)).client,
      other,
    );
    assert.ok(
      (await getChatModelClient(modelRouteId(model("gone", "other")))).error,
    );
    mock(chatModelsCache, "getChatModels", async () => [
      other,
      model("shared", "third"),
    ]);
    assert.ok((await getChatModelClient("shared")).error);
  });

  test("rejects a DSH models section owned by a different provider", () => {
    const original = block().replace(
      "        models:",
      "      other-provider:\n        models:",
    );
    assert.throws(() =>
      appendCatalogModels({ path: "unused", kind: "dsh" }, original, [
        model("fresh"),
      ]),
    );
  });

  test("rejects escaped DSH overrides outside the managed section", () => {
    const original = `${block()}\n- id: "llm-pi-\\u0061i"\n  config: {}\n`;
    assert.throws(() =>
      appendCatalogModels({ path: "unused", kind: "dsh" }, original, [
        model("fresh"),
      ]),
    );
  });

  test("maps actual capacities and image flags without inventing missing limits", () => {
    const mapped = modelToDshConfig(
      model("new", "other", {
        name: "Pretty (Agent Maestro)",
        maxOutputTokens: 32768,
        capabilities: { supportsImageToText: true },
      }),
    );
    assert.strictEqual(mapped.modelName, "Pretty (Agent Maestro)");
    assert.strictEqual(mapped.modelContextWindow, 921793);
    assert.strictEqual(mapped.modelMaxOutputTokens, 32768);
    assert.deepStrictEqual(mapped.modelInput, ["text", "image"]);
    const invalid = modelToDshConfig(
      model("bad", "other", { maxInputTokens: NaN, maxOutputTokens: -1 }),
    );
    assert.strictEqual(invalid.modelContextWindow, undefined);
    assert.strictEqual(invalid.modelMaxOutputTokens, undefined);
    assert.deepStrictEqual(invalid.modelInput, ["text"]);
  });
  for (const newline of ["\n", "\r\n"]) {
    test(`appends all-vendor DSH models preserving defaults, keys, endpoints and UI (${JSON.stringify(newline)})`, () => {
      const original =
        `# before\n${block()}\n- id: ui-chat\n  config:\n    transcriptView: standard\n`.replace(
          /\n/g,
          newline,
        );
      const target = file("profiles/desktop/cordis.patch.yml", original);
      const added = model("new", "other", {
        maxInputTokens: 271790,
        maxOutputTokens: 16384,
        capabilities: { imageInput: true },
      });
      const updated = appendCatalogModels(target, original, [
        model("old"),
        added,
        added,
      ]);
      assert.strictEqual(
        updated.split(`- id: ${JSON.stringify(modelRouteId(added))}`).length -
          1,
        1,
      );
      assert.ok(updated.includes(`contextWindow: 271790${newline}`));
      assert.ok(updated.includes(`maxTokens: 16384${newline}`));
      assert.ok(updated.includes(`- text${newline}              - image`));
      assert.ok(updated.includes('model: "old"'));
      assert.ok(
        updated.includes('baseURL: "http://localhost:24567/api/openai/v1/"'),
      );
      assert.ok(updated.includes("apiKeyEnv: AGENT_MAESTRO_API_KEY"));
      assert.strictEqual(
        updated.slice(updated.indexOf("- id: ui-chat")),
        original.slice(original.indexOf("- id: ui-chat")),
      );
      if (newline === "\r\n") {
        assert.ok(!/(?<!\r)\n/.test(updated));
      }
      assert.strictEqual(
        appendCatalogModels(target, updated, [added]),
        updated,
      );
      assert.strictEqual(read(target), original);
    });
  }
  test("legacy managed catalog appends without changing prior settings", () => {
    const original = createDshManagedBlock({
      baseURL: "http://localhost:23456/api/openai/v1",
      modelId: "old",
      format: "legacy-settings",
    });
    const target = file("settings.yaml", original);
    const updated = appendCatalogModels(target, original, [model("next")]);
    assert.ok(updated.includes('        - id: "next"'));
    assert.ok(updated.includes("api: openai-responses"));
    assert.ok(
      updated.includes('baseURL: "http://localhost:23456/api/openai/v1"'),
    );
  });
  test("WorkBuddy files preserve independent keys, endpoints, whitelist and custom model settings", () => {
    for (const [directory, key, port] of [
      [".codebuddy", "code-key", 23333],
      [".workbuddy", "work-key", 24444],
    ] as const) {
      const originalConfig = {
        models: [
          {
            id: "old",
            url: `http://localhost:${port}/api/openai/v1/chat/completions`,
            apiKey: key,
            temperature: 0.8,
          },
          {
            id: "custom",
            url: "https://example.invalid/v1",
            apiKey: "custom-key",
          },
        ],
        availableModels: ["custom"],
        selectedModel: "custom",
        extra: { untouched: true },
      };
      const original = JSON.stringify(originalConfig);
      const target = file(`${directory}/models.json`, original, "workbuddy");
      const result = JSON.parse(
        appendCatalogModels(target, original, [
          model("new", "other", {
            capabilities: { supportsImageToText: true, toolCalling: 0 },
            maxOutputTokens: 1234,
          }),
        ]),
      );
      assert.deepStrictEqual(result.models.slice(0, 2), originalConfig.models);
      assert.deepStrictEqual(result.availableModels, ["custom"]);
      assert.strictEqual(result.selectedModel, "custom");
      assert.deepStrictEqual(result.extra, { untouched: true });
      assert.strictEqual(result.models[2].apiKey, key);
      assert.strictEqual(result.models[2].url, originalConfig.models[0].url);
      assert.strictEqual(result.models[2].supportsImages, true);
      assert.strictEqual(result.models[2].supportsToolCall, false);
      assert.strictEqual(result.models[2].maxOutputTokens, 1234);
    }
  });
  for (const content of [
    "",
    "theme: dark",
    "- id: llm-pi-ai\n  config:\n    providers:\n      agent-maestro:\n        apiKeyEnv: AGENT_MAESTRO_API_KEY\n        models: []\n",
    block().replace("# <<< Agent Maestro DSH provider <<<", ""),
  ]) {
    test(`skips unsupported DSH layout ${JSON.stringify(content.slice(0, 30))}`, () => {
      const target = file("unsupported.yml", content);
      assert.throws(() => appendCatalogModels(target, content, [model("new")]));
      assert.strictEqual(read(target), content);
    });
  }
  test("unconfigured/malformed WorkBuddy catalogs are not treated as Maestro catalogs", () => {
    const target = {
      path: path.join(root, "models.json"),
      kind: "workbuddy" as const,
    };
    for (const value of [
      "not-json",
      "null",
      '{"models":[]}',
      '{"models":[{"url":"https://example.invalid/api/openai/v1/chat/completions"}]}',
    ]) {
      assert.strictEqual(hasPopulatedCatalog(target, value), false);
      assert.throws(() => appendCatalogModels(target, value, [model("new")]));
    }
  });
  test("writes approved updates with an exact-original backup", () => {
    const target = file("approved.yml", "original");
    writeCatalogUpdate(target, "original", "updated");
    assert.strictEqual(read(target), "updated");
    const backups = fs
      .readdirSync(root)
      .filter((name) => name.endsWith(".bak"));
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(
      fs.readFileSync(path.join(root, backups[0]), "utf8"),
      "original",
    );
  });
  test("dirty and concurrently edited files are not overwritten or backed up", () => {
    const target = file("protected.yml", "original");
    mock(vscode.workspace, "textDocuments", [
      { uri: vscode.Uri.file(target.path), isDirty: true },
    ]);
    assert.throws(
      () => writeCatalogUpdate(target, "original", "updated"),
      /unsaved/,
    );
    assert.strictEqual(read(target), "original");
    mock(vscode.workspace, "textDocuments", []);
    fs.writeFileSync(target.path, "concurrent");
    assert.throws(
      () => writeCatalogUpdate(target, "original", "updated"),
      /changed/,
    );
    assert.strictEqual(read(target), "concurrent");
    assert.ok(!fs.readdirSync(root).some((name) => name.endsWith(".bak")));
  });
  test("unchanged content is a no-op without backup", () => {
    const target = file("unchanged.yml", "same");
    writeCatalogUpdate(target, "same", "same");
    assert.deepStrictEqual(fs.readdirSync(root), ["unchanged.yml"]);
  });
  test("discovers existing profile/workspace targets and remembers independent paths", async () => {
    const desktop = file("profiles/desktop/cordis.patch.yml", block());
    const workspace = path.join(root, "workspace");
    const workbuddy = file("workspace/.workbuddy/models.json", "{}");
    const remembered = file("elsewhere/catalog.yml", block());
    mock(vscode.workspace, "workspaceFolders", [
      { uri: vscode.Uri.file(workspace) },
      { uri: vscode.Uri.parse("vscode-remote://host/remote") },
    ]);
    await rememberCatalogTargets(context, [remembered, remembered]);
    assert.strictEqual(
      (state.get(CATALOG_TARGETS_KEY) as CatalogTarget[]).length,
      1,
    );
    const targets = findCatalogTargets(context).map((target) => target.path);
    assert.ok(targets.includes(desktop.path));
    assert.ok(
      targets.some(
        (target) => target.toLowerCase() === workbuddy.path.toLowerCase(),
      ),
    );
    assert.ok(targets.includes(remembered.path));
    assert.strictEqual(new Set(targets).size, targets.length);
  });
  test("watcher prompts for newly observed models and updates only after approval", async function () {
    this.timeout(5000);
    const original = `${block()}\n`;
    const target = file("profiles/desktop/cordis.patch.yml", original);
    const old = model("old");
    const fresh = model("fresh", "other", {
      capabilities: { imageInput: true },
    });
    state.set(MODEL_SNAPSHOT_KEY, [modelIdentity(old)]);
    let event: (() => void) | undefined;
    let eventDisposed = false;
    const messages: string[] = [];
    mock(vscode.lm, "onDidChangeChatModels", (listener: () => void) => {
      event = listener;
      return {
        dispose: () => {
          eventDisposed = true;
        },
      };
    });
    mock(vscode.lm, "selectChatModels", async () => [old, fresh]);
    mock(chatModelsCache, "refresh", async () => undefined);
    mock(chatModelsCache, "getChatModels", async () => [old, fresh]);
    mock(
      vscode.window,
      "showInformationMessage",
      async (message: string, ...choices: string[]) => {
        messages.push(message);
        return choices.includes("Update model lists")
          ? "Update model lists"
          : undefined;
      },
    );
    const watcher = registerModelCatalogWatcher(context);
    watchers.push(watcher);
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.ok(read(target).includes(JSON.stringify(modelRouteId(fresh))));
    assert.strictEqual(
      messages.filter((message) =>
        message.startsWith("New VS Code models available"),
      ).length,
      1,
    );
    event?.();
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.strictEqual(
      messages.filter((message) =>
        message.startsWith("New VS Code models available"),
      ).length,
      1,
    );
    watcher.dispose();
    assert.strictEqual(eventDisposed, true);
  });
  test("dismissal does not write or repeat the same notification", async function () {
    this.timeout(4000);
    const target = file("profiles/desktop/cordis.patch.yml", `${block()}\n`);
    const original = read(target);
    state.set(MODEL_SNAPSHOT_KEY, [modelIdentity(model("old"))]);
    let event: (() => void) | undefined;
    let prompts = 0;
    mock(vscode.lm, "onDidChangeChatModels", (listener: () => void) => {
      event = listener;
      return { dispose() {} };
    });
    mock(vscode.lm, "selectChatModels", async () => [
      model("old"),
      model("fresh"),
    ]);
    mock(chatModelsCache, "refresh", async () => undefined);
    mock(chatModelsCache, "getChatModels", async () => [
      model("old"),
      model("fresh"),
    ]);
    mock(vscode.window, "showInformationMessage", async () => {
      prompts++;
      return "Not now";
    });
    watchers.push(registerModelCatalogWatcher(context));
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.strictEqual(read(target), original);
    event?.();
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.strictEqual(prompts, 1);
    assert.ok(
      !fs
        .readdirSync(path.dirname(target.path))
        .some((name) => name.endsWith(".bak")),
    );
  });

  test("watcher establishes first snapshot silently and disposal cancels pending work", async function () {
    this.timeout(4000);
    let calls = 0;
    mock(vscode.lm, "onDidChangeChatModels", () => ({ dispose() {} }));
    mock(vscode.lm, "selectChatModels", async () => {
      calls++;
      return [model("first")];
    });
    mock(chatModelsCache, "refresh", async () => undefined);
    mock(vscode.window, "showInformationMessage", async () => {
      throw new Error("Initial snapshot must not prompt");
    });
    const watcher = registerModelCatalogWatcher(context);
    watchers.push(watcher);
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(state.get(MODEL_SNAPSHOT_KEY), [
      modelIdentity(model("first")),
    ]);
    const canceled = registerModelCatalogWatcher(context);
    watchers.push(canceled);
    canceled.dispose();
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.strictEqual(calls, 1);
  });
});
