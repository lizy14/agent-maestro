import * as assert from "assert";
import * as fs from "fs";
import os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { registerConfiguratorCommands } from "../../commands/configuratorCommands";
import { ProxyServer } from "../../server/ProxyServer";
import { chatModelsCache } from "../../utils/chatModels";
import { logger } from "../../utils/logger";

suite("DSH Configurator Command Test Suite", () => {
  type RuntimeModel = vscode.LanguageModelChat & {
    maxOutputTokens?: number;
    capabilities?: {
      imageInput?: boolean;
      supportsImageToText?: boolean;
      toolCalling?: boolean;
    };
  };
  type PickerItem = { label: string; modelId?: string };
  const restorers: (() => void)[] = [];
  let tempHome: string;
  let previousDshHome: string | undefined;
  let commands: Map<string, () => Promise<void>>;
  let models: RuntimeModel[];
  let choices: (string | undefined)[];
  let inputValue: string | undefined;
  let errors: string[];
  let openedDocuments: unknown[];
  let refreshCalls: number;
  let mutateDuringModelPick: (() => void) | undefined;

  function mockProperty(target: object, key: string, value: unknown): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value,
    });
    restorers.push(() => {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor);
      } else {
        Reflect.deleteProperty(target, key);
      }
    });
  }

  function patchPath(profile = "desktop"): string {
    return path.join(tempHome, "profiles", profile, "cordis.patch.yml");
  }

  function writePatch(content: string): void {
    const target = patchPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }

  async function runCommand(
    name = "agent-maestro.configureDsh",
  ): Promise<void> {
    const command = commands.get(name);
    assert.ok(command, `Command ${name} should be captured`);
    await command();
  }

  setup(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "am-dsh-configurator-"));
    previousDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = tempHome;
    commands = new Map();
    models = [
      {
        id: "gpt-6.1-sol",
        name: "GPT-6.1 Sol",
        vendor: "copilot",
        family: "gpt",
        version: "1",
        maxInputTokens: 921793,
        maxOutputTokens: 32768,
        capabilities: { imageInput: true, toolCalling: true },
      } as RuntimeModel,
    ];
    choices = ["DSH Desktop", "gpt-6.1-sol"];
    inputValue = "custom-profile";
    errors = [];
    openedDocuments = [];
    refreshCalls = 0;
    mutateDuringModelPick = undefined;

    mockProperty(
      vscode.commands,
      "registerCommand",
      (name: string, callback: () => Promise<void>) => {
        commands.set(name, callback);
        return { dispose() {} };
      },
    );
    mockProperty(
      vscode.window,
      "showQuickPick",
      async (items: readonly (string | PickerItem)[]) => {
        const choice = choices.shift();
        if (items.some((item) => typeof item !== "string" && item.modelId)) {
          mutateDuringModelPick?.();
        }
        if (choice === undefined) {
          return undefined;
        }
        const selected = items.find((item) =>
          typeof item === "string"
            ? item === choice
            : item.modelId === choice || item.label === choice,
        );
        assert.ok(
          selected,
          `Queued picker choice ${choice} should be available`,
        );
        return selected;
      },
    );
    mockProperty(vscode.window, "showInputBox", async () => inputValue);
    mockProperty(
      vscode.window,
      "showInformationMessage",
      async () => undefined,
    );
    mockProperty(vscode.window, "showErrorMessage", async (message: string) => {
      errors.push(message);
      return undefined;
    });
    mockProperty(
      vscode.workspace,
      "openTextDocument",
      async (options: unknown) => {
        openedDocuments.push(options);
        return options;
      },
    );
    mockProperty(vscode.window, "showTextDocument", async () => undefined);
    mockProperty(vscode.lm, "selectChatModels", async () => {
      throw new Error("Configurator tests must not query live language models");
    });
    mockProperty(chatModelsCache, "refresh", async () => {
      refreshCalls++;
    });
    mockProperty(chatModelsCache, "getChatModels", async () => models);
    mockProperty(chatModelsCache, "getCachedModels", () => models);
    mockProperty(logger, "info", () => undefined);
    mockProperty(logger, "warn", () => undefined);
    mockProperty(logger, "error", () => undefined);
    mockProperty(os, "homedir", () => tempHome);

    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const proxy = {
      getStatus: () => ({ port: 24567 }),
    } as unknown as ProxyServer;
    registerConfiguratorCommands(proxy, context);
    assert.ok(context.subscriptions.length > 0);
  });

  teardown(() => {
    while (restorers.length) {
      restorers.pop()!();
    }
    if (previousDshHome === undefined) {
      delete process.env.DSH_HOME;
    } else {
      process.env.DSH_HOME = previousDshHome;
    }
    assert.ok(path.basename(tempHome).startsWith("am-dsh-configurator-"));
    assert.strictEqual(path.dirname(tempHome), os.tmpdir());
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  test("desktop setup writes live model identity, provider label, context and output limits", async () => {
    await runCommand();
    const content = fs.readFileSync(patchPath(), "utf8");
    assert.ok(content.includes('displayName: "Agent Maestro"'));
    assert.ok(content.includes('name: "GPT-6.1 Sol (Agent Maestro)"'));
    assert.ok(
      content.includes('baseURL: "http://127.0.0.1:24567/api/openai/v1/"'),
    );
    assert.ok(content.includes("api: openai-completions"));
    assert.ok(content.includes("contextWindow: 921793"));
    assert.ok(content.includes("maxTokens: 32768"));
    assert.ok(
      content.includes("input:\n              - text\n              - image"),
    );
    assert.ok(content.includes('model: "gpt-6.1-sol"'));
    assert.strictEqual(refreshCalls, 1);
    assert.deepStrictEqual(errors, []);
  });

  test("exports every supported model while selecting only the default", async () => {
    models.push({
      ...models[0],
      id: "gpt-6-luna",
      name: "GPT-6 Luna",
      maxInputTokens: 871793,
      maxOutputTokens: 16384,
      capabilities: { imageInput: false },
    });
    await runCommand();
    const content = fs.readFileSync(patchPath(), "utf8");
    assert.ok(content.includes('- id: "gpt-6.1-sol"'));
    assert.ok(content.includes('- id: "gpt-6-luna"'));
    assert.ok(content.includes('name: "GPT-6 Luna (Agent Maestro)"'));
    assert.ok(content.includes("contextWindow: 871793"));
    assert.ok(content.includes("maxTokens: 16384"));
    assert.ok(content.includes('    model: "gpt-6.1-sol"'));
    assert.deepStrictEqual(errors, []);
  });

  test("deduplicates repeated model IDs in the Desktop catalog", async () => {
    models.push({ ...models[0] });
    await runCommand();
    const content = fs.readFileSync(patchPath(), "utf8");
    assert.strictEqual(content.match(/- id: "gpt-6.1-sol"/g)?.length, 1);
    assert.deepStrictEqual(errors, []);
  });

  test("Copilot runtime image capability enables image input", async () => {
    models[0].capabilities = { supportsImageToText: true };
    await runCommand();
    assert.ok(
      fs.readFileSync(patchPath(), "utf8").includes("              - image"),
    );
    assert.deepStrictEqual(errors, []);
  });

  test("explicit unsupported image metadata writes text-only input", async () => {
    models[0].capabilities = { imageInput: false, supportsImageToText: false };
    await runCommand();
    const content = fs.readFileSync(patchPath(), "utf8");
    assert.ok(content.includes("input:\n              - text"));
    assert.ok(!content.includes("- image"));
    assert.deepStrictEqual(errors, []);
  });

  test("missing image capability does not invent image support", async () => {
    delete models[0].capabilities;
    await runCommand();
    assert.ok(!fs.readFileSync(patchPath(), "utf8").includes("- image"));
    assert.deepStrictEqual(errors, []);
  });

  test("missing output limit is omitted rather than guessed", async () => {
    delete models[0].maxOutputTokens;
    await runCommand();
    const content = fs.readFileSync(patchPath(), "utf8");
    assert.ok(content.includes("contextWindow: 921793"));
    assert.ok(!content.includes("maxTokens:"));
    assert.deepStrictEqual(errors, []);
  });

  test("unknown input context and nonpositive output limits are omitted", async () => {
    models[0] = { ...models[0], maxInputTokens: 0, maxOutputTokens: 0 };
    await runCommand();
    const content = fs.readFileSync(patchPath(), "utf8");
    assert.ok(!content.includes("contextWindow:"));
    assert.ok(!content.includes("maxTokens:"));
    assert.deepStrictEqual(errors, []);
  });

  test("already suffixed runtime name is not suffixed twice", async () => {
    models[0] = { ...models[0], name: "GPT-6.1 Sol (Agent Maestro)" };
    await runCommand();
    const content = fs.readFileSync(patchPath(), "utf8");
    assert.ok(content.includes('name: "GPT-6.1 Sol (Agent Maestro)"'));
    assert.ok(!content.includes("(Agent Maestro) (Agent Maestro)"));
  });

  test("named-profile setup writes only the chosen temporary profile", async () => {
    choices = ["DSH CLI / Web Profile", "gpt-6.1-sol"];
    await runCommand();
    assert.ok(fs.existsSync(patchPath("custom-profile")));
    assert.ok(!fs.existsSync(patchPath()));
    assert.deepStrictEqual(errors, []);
  });

  test("unmanaged existing YAML is unchanged and receives a manual merge suggestion", async () => {
    const original =
      "- id: llm-pi-ai\n  config:\n    providers:\n      preserve-me:\n        api: openai-completions\n";
    writePatch(original);
    choices = ["DSH Desktop", "Yes", "gpt-6.1-sol"];
    await runCommand();
    assert.strictEqual(fs.readFileSync(patchPath(), "utf8"), original);
    assert.strictEqual(fs.readdirSync(path.dirname(patchPath())).length, 1);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes("No changes were made"));
    assert.ok(openedDocuments.length > 0);
  });

  test("reconfigures owned model catalog while preserving UI and MCP entries", async () => {
    await runCommand();
    const original = fs.readFileSync(patchPath(), "utf8");
    const unrelated =
      "\n- id: ui-chat\n  config:\n    enabled: true\n- insert:\n    - id: custom-mcp\n      config:\n        command: pwsh\n";
    writePatch(original + unrelated);
    choices = ["DSH Desktop", "Yes", "gpt-6.1-sol"];
    await runCommand();
    assert.ok(fs.readFileSync(patchPath(), "utf8").endsWith(unrelated));
    assert.deepStrictEqual(errors, []);
  });

  test("canceling installation selection creates no configuration", async () => {
    choices = [undefined];
    await runCommand();
    assert.ok(!fs.existsSync(patchPath()));
    assert.strictEqual(refreshCalls, 0);
    assert.deepStrictEqual(errors, []);
  });

  test("canceling model selection creates no configuration", async () => {
    choices = ["DSH Desktop", undefined];
    await runCommand();
    assert.ok(!fs.existsSync(patchPath()));
    assert.strictEqual(refreshCalls, 1);
    assert.deepStrictEqual(errors, []);
  });

  test("canceling profile input creates no configuration", async () => {
    choices = ["DSH CLI / Web Profile"];
    inputValue = undefined;
    await runCommand();
    assert.deepStrictEqual(fs.readdirSync(tempHome), []);
    assert.strictEqual(refreshCalls, 0);
    assert.deepStrictEqual(errors, []);
  });

  test("canceling an existing-file update preserves its bytes", async () => {
    writePatch("[]\n");
    choices = ["DSH Desktop", "No"];
    await runCommand();
    assert.strictEqual(fs.readFileSync(patchPath(), "utf8"), "[]\n");
    assert.strictEqual(refreshCalls, 0);
    assert.deepStrictEqual(errors, []);
  });

  test("empty discovery reports an error without making live requests or files", async () => {
    models = [];
    choices = ["DSH Desktop"];
    await runCommand();
    assert.ok(!fs.existsSync(patchPath()));
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes("No available chat model"));
  });

  test("editing the patch while selecting a model is not overwritten", async () => {
    const original = "[]\n";
    const edited = "# concurrently edited\n[]\n";
    writePatch(original);
    choices = ["DSH Desktop", "Yes", "gpt-6.1-sol"];
    mutateDuringModelPick = () => writePatch(edited);
    await runCommand();
    assert.strictEqual(fs.readFileSync(patchPath(), "utf8"), edited);
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes("changed during setup"));
    assert.strictEqual(fs.readdirSync(path.dirname(patchPath())).length, 1);
  });
});
