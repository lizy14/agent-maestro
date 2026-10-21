import * as assert from "assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { CodexSessionNames, codexSessionIndex } from "../../usage/sessionNames";

suite("Automatic Codex session names", () => {
  let home: string;
  setup(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-names-"));
  });
  teardown(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  test("uses explicit home then CODEX_HOME then default without workspace search", () => {
    const custom = path.join(home, "custom"),
      env = path.join(home, "env");
    assert.strictEqual(
      codexSessionIndex(custom, env, home),
      path.join(custom, "session_index.jsonl"),
    );
    assert.strictEqual(
      codexSessionIndex("", env, home),
      path.join(env, "session_index.jsonl"),
    );
    assert.strictEqual(
      codexSessionIndex("", "", home),
      path.join(home, ".codex", "session_index.jsonl"),
    );
    assert.strictEqual(
      codexSessionIndex("~/codex", "", home),
      path.join(home, "codex", "session_index.jsonl"),
    );
    assert.throws(() => codexSessionIndex("relative", "", "/home"), /absolute/);
  });
  test("reads only the metadata file and refreshes titles after changes", async () => {
    const file = path.join(home, "session_index.jsonl");
    await fs.writeFile(
      path.join(home, "auth.json"),
      "not valid json: must not read",
    );
    await fs.writeFile(file, '{"id":"session","thread_name":"First"}\n');
    const loader = new CodexSessionNames();
    const initial = await loader.read(file);
    assert.strictEqual(initial.status, "loaded");
    assert.strictEqual(initial.names.session, "First");
    assert.strictEqual((await loader.read(file)).names, initial.names);
    await fs.appendFile(
      file,
      '{"id":"session","thread_name":"Updated name"}\n{"id":"partial","title":"in flight"}',
    );
    const updated = await loader.read(file);
    assert.strictEqual(updated.names.session, "Updated name");
    assert.strictEqual(updated.names.partial, undefined);
    await fs.appendFile(file, "\n");
    assert.strictEqual((await loader.read(file)).names.partial, "in flight");
    await fs.unlink(file);
    assert.strictEqual((await loader.read(file)).status, "missing");
    assert.deepStrictEqual(Object.keys((await loader.read(file)).names), []);
  });
  test("bounds reads and degrades gracefully for missing/invalid sources", async () => {
    const loader = new CodexSessionNames(),
      file = path.join(home, "session_index.jsonl");
    assert.strictEqual((await loader.read(file)).status, "missing");
    assert.strictEqual((await loader.read(home)).status, "unavailable");
    await fs.writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1));
    assert.strictEqual((await loader.read(file)).status, "too-large");
    await fs.writeFile(file, 'garbage\n{"id":"good","title":"Okay"}\n');
    assert.strictEqual((await loader.read(file)).names.good, "Okay");
    loader.clear();
    assert.strictEqual((await loader.read(file)).names.good, "Okay");
  });
});
