import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  BuddyModel,
  isMaestroBuddyModel,
  mergeBuddySettings,
  readBuddySettings,
  writeBuddySettings,
} from "../../utils/buddySettings";

suite("Buddy settings preservation", () => {
  let directory: string;
  const model = (id: string, extra: Partial<BuddyModel> = {}): BuddyModel => ({
    id,
    name: `${id} (Agent Maestro)`,
    url: "http://127.0.0.1:23333/api/openai/v1/chat/completions",
    apiKey: "placeholder",
    supportsToolCall: true,
    supportsImages: false,
    ...extra,
  });
  setup(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "am-buddy-safe-"));
  });
  teardown(() => {
    assert.strictEqual(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith("am-buddy-safe-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  test("missing file is an empty snapshot without creating it", () => {
    const file = path.join(directory, "models.json");
    assert.deepStrictEqual(readBuddySettings(file), {
      path: file,
      settings: {},
    });
    assert.ok(!fs.existsSync(file));
  });
  for (const content of [
    "null",
    "[]",
    "1",
    '"text"',
    "{broken",
    '{"models":null}',
    '{"models":{}}',
    '{"models":[{}]}',
    '{"models":[{"id":""}]}',
    '{"models":[{"id":42}]}',
    '{"availableModels":null}',
    '{"availableModels":"x"}',
    '{"models":[null]}',
    '{"models":[{"id":"x"},{"id":"x"}]}',
    '{"availableModels":[1]}',
  ]) {
    test(`rejects malformed configuration ${content}`, () => {
      const file = path.join(directory, "models.json");
      fs.writeFileSync(file, content);
      assert.throws(() => readBuddySettings(file));
      assert.strictEqual(fs.readFileSync(file, "utf8"), content);
    });
  }
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    test(`recognizes Maestro ownership at ${host}`, () => {
      assert.strictEqual(
        isMaestroBuddyModel(
          model("a", {
            url: `http://${host}:24567/api/openai/v1/chat/completions`,
          }),
        ),
        true,
      );
    });
  }
  for (const extra of [
    { name: "Custom" },
    { name: undefined },
    { url: undefined },
    { url: "broken" },
    { url: "https://example.com/api/openai/v1/chat/completions" },
    { url: "http://127.0.0.1:23333/other" },
    { url: "http://localhost.example.com/api/openai/v1/chat/completions" },
    { url: "https://localhost/api/openai/v1/chat/completions" },
  ]) {
    test(`does not claim unrelated ownership ${JSON.stringify(extra)}`, () => {
      assert.strictEqual(isMaestroBuddyModel(model("a", extra)), false);
    });
  }
  test("missing nested path creates neither parent directory nor file", () => {
    const target = path.join(directory, "absent", "models.json");
    readBuddySettings(target);
    assert.deepStrictEqual(fs.readdirSync(directory), []);
  });
  test("rejects directory settings without replacing it", () => {
    const target = path.join(directory, "models.json");
    fs.mkdirSync(target);
    assert.throws(() => readBuddySettings(target), /regular/);
    assert.ok(fs.statSync(target).isDirectory());
  });

  test("preserves independent product credentials and custom top-level fields", () => {
    const one = mergeBuddySettings(
      { models: [model("old", { apiKey: "one" })], custom: "first" },
      [model("new")],
    );
    const two = mergeBuddySettings(
      { models: [model("old", { apiKey: "two" })], custom: "second" },
      [model("new")],
    );
    assert.strictEqual(one.models![1].apiKey, "one");
    assert.strictEqual(two.models![1].apiKey, "two");
    assert.strictEqual(one.custom, "first");
    assert.strictEqual(two.custom, "second");
  });
  test("keeps custom rows and temporarily unavailable Maestro rows", () => {
    const custom = model("custom", {
      name: "My custom",
      url: "https://example.com/v1",
    });
    const result = mergeBuddySettings(
      { models: [custom, model("unavailable")] },
      [model("new")],
    );
    assert.deepStrictEqual(result.models![0], custom);
    assert.deepStrictEqual(
      result.models!.map((item) => item.id),
      ["custom", "unavailable", "new"],
    );
  });
  test("never reroutes an unrelated provider with the same ID", () => {
    const custom = model("same", {
      name: "Custom same",
      url: "https://example.com",
      apiKey: "custom",
    });
    assert.deepStrictEqual(
      mergeBuddySettings({ models: [custom] }, [model("same")]).models,
      [custom],
    );
  });
  test("updates live capabilities but retains unknown per-row fields and secret", () => {
    const result = mergeBuddySettings(
      {
        models: [
          model("same", {
            apiKey: "original",
            supportsImages: true,
            custom: 42,
          }),
        ],
      },
      [model("same", { supportsImages: false, apiKey: "replacement" })],
    );
    assert.strictEqual(result.models![0].apiKey, "original");
    assert.strictEqual(result.models![0].supportsImages, false);
    assert.strictEqual(result.models![0].custom, 42);
  });
  test("preserves unknown capabilities and deliberate availableModels whitelist", () => {
    const result = mergeBuddySettings(
      {
        models: [model("same", { supportsImages: true })],
        availableModels: ["same"],
      },
      [{ id: "same", name: "same (Agent Maestro)" }, model("new")],
    );
    assert.strictEqual(result.models![0].supportsImages, true);
    assert.deepStrictEqual(result.availableModels, ["same"]);
  });
  test("merge leaves inputs unchanged and retains per-row vendor, unknown capabilities and options", () => {
    const old = model("a", {
      apiKey: "original",
      vendor: "Original vendor",
      supportsImages: true,
      supportsToolCall: false,
      custom: 42,
      maxInputTokens: 100,
    });
    const incoming: BuddyModel = {
      id: "a",
      name: "a (Agent Maestro)",
      url: "http://localhost:24567/api/openai/v1/chat/completions",
      apiKey: "replacement",
      maxInputTokens: 200,
    };
    const settings = {
      models: [old],
      selectedModel: "a",
      availableModels: ["a"],
    };
    const before = JSON.stringify(settings),
      beforeIncoming = JSON.stringify(incoming);
    const result = mergeBuddySettings(settings, [incoming]);
    assert.strictEqual(result.models![0].vendor, "Original vendor");
    assert.strictEqual(result.models![0].apiKey, "original");
    assert.strictEqual(result.models![0].supportsImages, true);
    assert.strictEqual(result.models![0].supportsToolCall, false);
    assert.strictEqual(result.models![0].maxInputTokens, 200);
    assert.strictEqual(result.models![0].custom, 42);
    assert.strictEqual(result.selectedModel, "a");
    assert.strictEqual(JSON.stringify(settings), before);
    assert.strictEqual(JSON.stringify(incoming), beforeIncoming);
  });
  test("custom label at loopback URL prevents silent same-ID takeover", () => {
    const custom = model("a", { name: "My custom label", apiKey: "own" });
    assert.deepStrictEqual(
      mergeBuddySettings({ models: [custom] }, [model("a")]).models,
      [custom],
    );
  });
  test("new row receives defaults when capability metadata is absent", () => {
    const result = mergeBuddySettings({}, [
      {
        id: "a",
        name: "a (Agent Maestro)",
        url: "http://localhost/api/openai/v1/chat/completions",
      },
    ]);
    assert.strictEqual(result.models![0].supportsImages, false);
    assert.strictEqual(result.models![0].supportsToolCall, true);
  });
  test("repeated incoming IDs do not duplicate appended rows", () => {
    const result = mergeBuddySettings({}, [
      model("a"),
      model("a", { supportsImages: true }),
    ]);
    assert.strictEqual(result.models!.length, 1);
    assert.strictEqual(result.models![0].supportsImages, true);
  });

  test("backs up only the destination's own bytes before changes", () => {
    const file = path.join(directory, "models.json");
    const original = '{\r\n  "models": [], "custom": 1\r\n}\r\n';
    fs.writeFileSync(file, original);
    const snapshot = readBuddySettings(file);
    assert.ok(
      writeBuddySettings(
        snapshot,
        mergeBuddySettings(snapshot.settings, [model("new")]),
      ),
    );
    const backup = fs
      .readdirSync(directory)
      .find((name) => name.endsWith(".bak"));
    assert.ok(backup);
    assert.strictEqual(
      fs.readFileSync(path.join(directory, backup), "utf8"),
      original,
    );
  });
  test("concurrent edits are not overwritten or backed up", () => {
    const file = path.join(directory, "models.json");
    fs.writeFileSync(file, "{}");
    const snapshot = readBuddySettings(file);
    fs.writeFileSync(file, '{"changed":true}');
    assert.throws(
      () => writeBuddySettings(snapshot, { models: [model("new")] }),
      /changed/,
    );
    assert.strictEqual(fs.readFileSync(file, "utf8"), '{"changed":true}');
    assert.strictEqual(fs.readdirSync(directory).length, 1);
  });
  test("newly appeared destination is not overwritten", () => {
    const file = path.join(directory, "models.json");
    const snapshot = readBuddySettings(file);
    fs.writeFileSync(file, "{}");
    assert.throws(
      () => writeBuddySettings(snapshot, { models: [model("new")] }),
      /changed/,
    );
  });
  test("sibling writes keep separate credentials, fields and exact original backups", () => {
    const paths = [
      path.join(directory, "codebuddy.json"),
      path.join(directory, "workbuddy.json"),
    ];
    const originals = paths.map((_target, index) =>
      JSON.stringify({
        models: [model("old", { apiKey: `key-${index}` })],
        product: index,
      }),
    );
    paths.forEach((target, index) =>
      fs.writeFileSync(target, originals[index]),
    );
    for (const target of paths) {
      const snapshot = readBuddySettings(target);
      writeBuddySettings(
        snapshot,
        mergeBuddySettings(snapshot.settings, [model("new")]),
      );
    }
    paths.forEach((target, index) => {
      const current = JSON.parse(fs.readFileSync(target, "utf8"));
      assert.strictEqual(current.models[1].apiKey, `key-${index}`);
      assert.strictEqual(current.product, index);
      const backup = fs
        .readdirSync(directory)
        .find(
          (name) =>
            name.startsWith(path.basename(target) + ".") &&
            name.endsWith(".bak"),
        );
      assert.ok(backup);
      assert.strictEqual(
        fs.readFileSync(path.join(directory, backup), "utf8"),
        originals[index],
      );
    });
  });
  test("absent destination is created without backup", () => {
    const target = path.join(directory, "new", "models.json"),
      snapshot = readBuddySettings(target);
    assert.strictEqual(
      writeBuddySettings(
        snapshot,
        mergeBuddySettings(snapshot.settings, [model("a")]),
      ),
      true,
    );
    assert.strictEqual(
      JSON.parse(fs.readFileSync(target, "utf8")).models[0].id,
      "a",
    );
    assert.deepStrictEqual(fs.readdirSync(path.dirname(target)), [
      "models.json",
    ]);
  });
  test("existing file deleted during setup is not recreated", () => {
    const target = path.join(directory, "models.json");
    fs.writeFileSync(target, "{}");
    const snapshot = readBuddySettings(target);
    fs.unlinkSync(target);
    assert.throws(
      () => writeBuddySettings(snapshot, { models: [model("a")] }),
      /changed/,
    );
    assert.ok(!fs.existsSync(target));
    assert.deepStrictEqual(fs.readdirSync(directory), []);
  });
  test("empty file appearing during setup is not overwritten", () => {
    const target = path.join(directory, "models.json"),
      snapshot = readBuddySettings(target);
    fs.writeFileSync(target, "");
    assert.throws(
      () => writeBuddySettings(snapshot, { models: [model("a")] }),
      /changed/,
    );
    assert.strictEqual(fs.readFileSync(target, "utf8"), "");
    assert.strictEqual(fs.readdirSync(directory).length, 1);
  });
  test("semantic no-op leaves exact formatting and mtime untouched", () => {
    const target = path.join(directory, "models.json"),
      settings = { models: [model("a")] };
    const original = JSON.stringify(settings);
    fs.writeFileSync(target, original);
    fs.utimesSync(target, new Date(1000000), new Date(1000000));
    const before = fs.statSync(target).mtimeMs,
      snapshot = readBuddySettings(target);
    assert.strictEqual(
      writeBuddySettings(
        snapshot,
        mergeBuddySettings(snapshot.settings, [model("a")]),
      ),
      false,
    );
    assert.strictEqual(fs.readFileSync(target, "utf8"), original);
    assert.strictEqual(fs.statSync(target).mtimeMs, before);
    assert.deepStrictEqual(fs.readdirSync(directory), ["models.json"]);
  });
  test("manifest contributes correct separate setup and fallback entries", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8"),
    );
    const commands = manifest.contributes.commands as {
      command: string;
      title: string;
      category: string;
    }[];
    for (const [id, title] of [
      [
        "agent-maestro.configureWorkBuddy",
        "Configure CodeBuddy / WorkBuddy Settings",
      ],
      ["agent-maestro.selectFallbackModel", "Select Fallback Model"],
    ]) {
      const entries = commands.filter((item) => item.command === id);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].title, title);
      assert.strictEqual(entries[0].category, "Agent Maestro");
    }
    assert.strictEqual(
      new Set(commands.map((item) => item.command)).size,
      commands.length,
    );
  });

  test("idempotent merge does not rewrite or create another backup", () => {
    const file = path.join(directory, "models.json");
    const settings = { models: [model("same")] };
    fs.writeFileSync(file, JSON.stringify(settings));
    const snapshot = readBuddySettings(file);
    assert.strictEqual(
      writeBuddySettings(
        snapshot,
        mergeBuddySettings(settings, [model("same")]),
      ),
      false,
    );
    assert.strictEqual(fs.readdirSync(directory).length, 1);
  });
});
