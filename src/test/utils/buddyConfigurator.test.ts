import * as assert from "assert";
import * as fs from "fs";
import os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { registerConfiguratorCommands } from "../../commands/configuratorCommands";
import { ProxyServer } from "../../server/ProxyServer";
import { chatModelsCache } from "../../utils/chatModels";

suite("Buddy setup preserves independent destinations", () => {
  let root: string;
  const restore: (() => void)[] = [];
  const mock = (target: object, key: string, value: unknown) => {
    const old = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value,
    });
    restore.push(() => {
      if (old) {
        Object.defineProperty(target, key, old);
      } else {
        Reflect.deleteProperty(target, key);
      }
    });
  };
  let run: () => Promise<void>;
  let prompts: string[];
  let answer: string;
  let errors: string[];
  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "am-buddy-command-"));
    prompts = [];
    errors = [];
    answer = "Yes";
    mock(os, "homedir", () => root);
    mock(
      vscode.commands,
      "registerCommand",
      (id: string, callback: () => Promise<void>) => {
        if (id === "agent-maestro.configureWorkBuddy") {
          run = callback;
        }
        return { dispose() {} };
      },
    );
    mock(
      vscode.window,
      "showQuickPick",
      async (items: unknown[], options: { placeHolder?: string }) => {
        if (typeof items[0] === "object") {
          return (items as { label: string }[]).find(
            (item) => item.label === "User Settings",
          );
        }
        prompts.push(options.placeHolder ?? "");
        return answer;
      },
    );
    mock(vscode.window, "showErrorMessage", async (message: string) => {
      errors.push(message);
    });
    mock(vscode.window, "showWarningMessage", async () => undefined);
    mock(vscode.window, "showInformationMessage", async () => undefined);
    mock(vscode.workspace, "textDocuments", []);
    mock(chatModelsCache, "getChatModels", async () => [
      {
        id: "gpt-new",
        name: "GPT New",
        vendor: "copilot",
        family: "gpt",
        maxInputTokens: 128000,
        capabilities: { toolCalling: 0, imageInput: false },
      },
    ]);
    registerConfiguratorCommands(
      { getStatus: () => ({ port: 24567 }) } as unknown as ProxyServer,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );
  });
  teardown(() => {
    while (restore.length) {
      restore.pop()!();
    }
    assert.strictEqual(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("am-buddy-command-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = (dir: string) => path.join(root, dir, "models.json");
  const write = (dir: string, content: string) => {
    fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
    fs.writeFileSync(file(dir), content);
  };
  test("prompts when only WorkBuddy exists and does not mirror its secrets", async () => {
    write(
      ".workbuddy",
      JSON.stringify({
        customSetting: "wb-only",
        availableModels: ["custom"],
        models: [
          {
            id: "custom",
            name: "Mine",
            apiKey: "test-key",
            url: "https://other.example/v1",
          },
        ],
      }),
    );
    await run();
    const wb = JSON.parse(fs.readFileSync(file(".workbuddy"), "utf8"));
    const cb = JSON.parse(fs.readFileSync(file(".codebuddy"), "utf8"));
    assert.strictEqual(prompts.length, 1);
    assert.ok(prompts[0].includes(".workbuddy"));
    assert.strictEqual(wb.customSetting, "wb-only");
    assert.deepStrictEqual(wb.availableModels, ["custom"]);
    assert.strictEqual(wb.models[0].apiKey, "test-key");
    assert.strictEqual(cb.customSetting, undefined);
    assert.ok(!JSON.stringify(cb).includes("test-key"));
    assert.strictEqual(cb.models[0].supportsToolCall, false);
    assert.strictEqual(cb.models[0].supportsImages, false);
    assert.deepStrictEqual(errors, []);
  });
  test("declining existing sibling prevents writes to both destinations", async () => {
    const original = JSON.stringify({ models: [], keep: true });
    write(".workbuddy", original);
    answer = "No";
    await run();
    assert.strictEqual(fs.readFileSync(file(".workbuddy"), "utf8"), original);
    assert.ok(!fs.existsSync(file(".codebuddy")));
  });
  test("invalid sibling settings fail closed without creating primary", async () => {
    write(".workbuddy", "null");
    await run();
    assert.ok(errors.length);
    assert.ok(!fs.existsSync(file(".codebuddy")));
    assert.strictEqual(fs.readFileSync(file(".workbuddy"), "utf8"), "null");
  });
});
