import * as assert from "assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { dashboardHtml } from "../../usage/dashboardHtml";
import {
  UsageRecord,
  filterRecords,
  groupRecords,
  parseRecord,
  parseSessionNames,
  sessionKey,
  summarize,
} from "../../usage/model";
import { UsageStore } from "../../usage/store";

const record = (id: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  version: 1,
  id,
  requestId: id,
  startedAt: Date.now(),
  durationMs: 100,
  endpoint: "/api/openai/v1/responses",
  model: "test-model",
  client: "Codex",
  outcome: "completed",
  ...extra,
});

suite("Usage aggregation and privacy", () => {
  test("weights cache rate by measured input, excludes unknown and inconsistent counts", () => {
    const rows = [
      record("a", {
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 90,
        reasoningTokens: 10,
      }),
      record("b", { inputTokens: 900, outputTokens: 30, cachedTokens: 0 }),
      record("c", { inputTokens: 10000, outputTokens: 5 }),
      record("d"),
      record("e", { inputTokens: 1, outputTokens: 1, cachedTokens: 2 }),
    ];
    const result = summarize(rows);
    assert.strictEqual(result.cacheHitRate, 0.09);
    assert.strictEqual(result.cacheReportedCalls, 2);
    assert.strictEqual(result.reportedCalls, 4);
    assert.strictEqual(result.outputTokens, 56);
    assert.strictEqual(result.reasoningTokens, 10);
    assert.strictEqual(summarize([]).cacheHitRate, null);
  });
  test("filters by session namespace, model and time", () => {
    const a = record("a", { sessionId: "same", startedAt: 100 }),
      b = record("b", { sessionId: "same", client: "Other", startedAt: 200 });
    assert.notStrictEqual(sessionKey(a), sessionKey(b));
    assert.deepStrictEqual(
      filterRecords([a, b], { session: sessionKey(a), since: 100 }),
      [a],
    );
    assert.strictEqual(filterRecords([a, b], { model: "missing" }).length, 0);
    assert.strictEqual(groupRecords([a, b], (row) => row.model)[0].calls, 2);
  });
  test("disk schema drops all unrecognized content and malformed counts", () => {
    const safe = parseRecord({
      ...record("a"),
      inputTokens: NaN,
      outputTokens: -1,
      authorization: "secret",
      prompt: "private",
      response: "private",
      sessionName: "x\n".repeat(200),
    });
    assert.ok(safe);
    assert.strictEqual(safe.inputTokens, undefined);
    assert.strictEqual(safe.outputTokens, undefined);
    assert.ok(safe.sessionName!.length <= 160);
    assert.ok(!JSON.stringify(safe).includes("private"));
    assert.ok(!JSON.stringify(safe).includes("secret"));
    assert.strictEqual(parseRecord({ ...record("b"), version: 2 }), undefined);
  });
  test("imports only session title metadata, tolerates incomplete records and safe special keys", () => {
    const names = parseSessionNames(
      '{"id":"abc","thread_name":"First","prompt":"never import"}\n{"id":"abc","title":"Renamed"}\n{"id":"__proto__","title":"safe"}\n{unfinished',
    );
    assert.strictEqual(names.abc, "Renamed");
    assert.strictEqual(names.__proto__, "safe");
    assert.strictEqual(Object.getPrototypeOf(names), null);
    assert.ok(!JSON.stringify(names).includes("never import"));
  });
  test("escapes untrusted labels and embeds no network resources", () => {
    const rows = [
      record("x", {
        model: "</script><img src=x onerror=alert(1)>",
        sessionName: "<script>bad</script>",
      }),
    ];
    const html = dashboardHtml("nonce123", rows, rows, {}, {}, 30, true, false);
    assert.ok(html.includes("&lt;script&gt;bad&lt;/script&gt;"));
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("default-src &#39;none&#39;"));
    assert.ok(!html.includes("<script src="));
    assert.ok(html.includes("unavailable token counts"));
  });
});

suite("Usage journal", () => {
  let directory: string;
  setup(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-usage-"));
  });
  teardown(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  test("concurrent writers preserve records across reloads without storing payloads", async () => {
    const a = new UsageStore(directory),
      b = new UsageStore(directory);
    for (let i = 0; i < 30; i++) {
      a.append(record("a" + i));
      b.append(record("b" + i));
    }
    await Promise.all([a.flush(), b.flush()]);
    const snapshot = await new UsageStore(directory).read();
    assert.strictEqual(snapshot.records.length, 60);
    assert.strictEqual((await fs.readdir(directory)).length, 2);
  });
  test("ignores partial and malformed lines without losing valid history", async () => {
    const store = new UsageStore(directory);
    store.append(record("ok"));
    await store.flush();
    const file = path.join(directory, (await fs.readdir(directory))[0]);
    await fs.appendFile(file, "broken\n" + JSON.stringify(record("partial")));
    assert.deepStrictEqual(
      (await store.read()).records.map((r) => r.id),
      ["ok"],
    );
  });
  test("prunes only owned journals and retains unrelated files", async () => {
    const file = path.join(directory, "usage-1-abc-0.jsonl");
    await fs.writeFile(file, JSON.stringify(record("old")) + "\n");
    const old = new Date(Date.now() - 31 * 86400000);
    await fs.utimes(file, old, old);
    await fs.writeFile(path.join(directory, "unrelated.jsonl"), "keep");
    assert.strictEqual(
      (await new UsageStore(directory).read()).records.length,
      0,
    );
    assert.strictEqual(
      await fs.readFile(path.join(directory, "unrelated.jsonl"), "utf8"),
      "keep",
    );
    await assert.rejects(fs.stat(file));
  });
  test("failed persistence cannot reject model completion", async () => {
    const file = path.join(directory, "file");
    await fs.writeFile(file, "not a directory");
    let errors = 0;
    const store = new UsageStore(file, () => errors++);
    store.append(record("a"));
    await store.flush();
    assert.strictEqual(errors, 1);
  });
  test("an unterminated journal is not treated as durable and duplicate IDs count once", async () => {
    await fs.writeFile(
      path.join(directory, "usage-1-abc-0.jsonl"),
      JSON.stringify(record("partial")),
    );
    const a = new UsageStore(directory),
      b = new UsageStore(directory);
    a.append(record("same"));
    b.append(record("same"));
    await Promise.all([a.flush(), b.flush()]);
    assert.deepStrictEqual(
      (await a.read()).records.map((r) => r.id),
      ["same"],
    );
  });
});
