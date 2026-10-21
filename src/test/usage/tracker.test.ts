import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import * as vscode from "vscode";

import { registerAnthropicRoutes } from "../../server/routes/anthropicRoutes";
import { registerGeminiRoutes } from "../../server/routes/geminiRoutes";
import { registerOpenaiChatRoutes } from "../../server/routes/openai/openaiChatRoutes";
import { registerOpenaiResponsesRoutes } from "../../server/routes/openai/openaiResponsesRoutes";
import { UsageRecord } from "../../usage/model";
import {
  configureUsageTracking,
  sendTrackedRequest,
  usageMiddleware,
} from "../../usage/tracker";

const usage = () =>
  new vscode.LanguageModelDataPart(
    Buffer.from(
      JSON.stringify({
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: {
          cached_tokens: 80,
          cache_creation_input_tokens: 5,
        },
        completion_tokens_details: { reasoning_tokens: 10 },
      }),
    ),
    "usage",
  );
const model = (
  parts: () => AsyncIterable<
    vscode.LanguageModelTextPart | vscode.LanguageModelDataPart
  >,
) =>
  ({
    id: "test-model",
    name: "Test",
    vendor: "copilot",
    family: "gpt",
    version: "1",
    maxInputTokens: 10000,
    countTokens: async () => 1,
    sendRequest: async () => ({
      stream: parts(),
      text: (async function* () {})(),
    }),
  }) as vscode.LanguageModelChat;

suite("Usage tracking through routes", () => {
  let records: UsageRecord[];
  setup(() => {
    records = [];
    configureUsageTracking(
      (row) => records.push(row),
      () => true,
    );
  });
  teardown(() =>
    configureUsageTracking(
      () => {},
      () => false,
    ),
  );
  for (const stream of [false, true]) {
    for (const protocol of [
      "responses",
      "chat",
      "anthropic",
      "gemini",
    ] as const) {
      test(
        protocol + " captures provider usage once (stream=" + stream + ")",
        async () => {
          const app = new OpenAPIHono();
          app.use("*", usageMiddleware());
          const client = model(async function* () {
            yield new vscode.LanguageModelTextPart("Hello");
            yield usage();
            yield usage();
          });
          const options = {
            resolveChatModelClient: async () => ({ client }),
            requestTimeoutMs: 2000,
          };
          let url: string, body: unknown;
          if (protocol === "responses") {
            registerOpenaiResponsesRoutes(app, options);
            url = "/v1/responses";
            body = { model: "test-model", input: "hello", stream };
          } else if (protocol === "chat") {
            registerOpenaiChatRoutes(app, options);
            url = "/v1/chat/completions";
            body = {
              model: "test-model",
              messages: [{ role: "user", content: "hello" }],
              stream,
            };
          } else if (protocol === "anthropic") {
            registerAnthropicRoutes(app, options);
            url = "/v1/messages";
            body = {
              model: "test-model",
              max_tokens: 50,
              messages: [{ role: "user", content: "hello" }],
              stream,
            };
          } else {
            registerGeminiRoutes(app, options);
            url =
              "/v1beta/models/test-model:" +
              (stream ? "streamGenerateContent" : "generateContent");
            body = { contents: [{ role: "user", parts: [{ text: "hello" }] }] };
          }
          const result = await app.request(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "codex_cli_rs/test",
              session_id: "test-session",
              authorization: "do-not-store",
            },
            body: JSON.stringify(body),
          });
          assert.strictEqual(result.status, 200);
          await result.text();
          assert.strictEqual(records.length, 1);
          assert.strictEqual(records[0].inputTokens, 100);
          assert.strictEqual(records[0].cachedTokens, 80);
          assert.strictEqual(records[0].cacheWriteTokens, 5);
          assert.strictEqual(records[0].reasoningTokens, 10);
          assert.strictEqual(records[0].sessionId, "test-session");
          assert.strictEqual(records[0].client, "Codex");
          assert.strictEqual(records[0].outcome, "completed");
          assert.ok(!JSON.stringify(records).includes("do-not-store"));
        },
      );
    }
  }
  test("missing provider usage remains unknown despite route fallback estimates", async () => {
    const app = new OpenAPIHono();
    app.use("*", usageMiddleware());
    registerOpenaiChatRoutes(app, {
      resolveChatModelClient: async () => ({
        client: model(async function* () {
          yield new vscode.LanguageModelTextPart("text");
        }),
      }),
    });
    const result = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await result.text();
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].inputTokens, undefined);
    assert.strictEqual(records[0].cachedTokens, undefined);
  });
  test("concurrent requests retain their own session context", async () => {
    const app = new OpenAPIHono();
    app.use("*", usageMiddleware());
    registerOpenaiResponsesRoutes(app, {
      resolveChatModelClient: async () => ({
        client: model(async function* () {
          await new Promise((r) => setTimeout(r, 5));
          yield usage();
        }),
      }),
    });
    await Promise.all(
      ["one", "two"].map(async (id) => {
        const response = await app.request("/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json", session_id: id },
          body: JSON.stringify({
            model: "test-model",
            input: "hi",
            stream: true,
          }),
        });
        await response.text();
      }),
    );
    assert.deepStrictEqual(records.map((r) => r.sessionId).sort(), [
      "one",
      "two",
    ]);
    assert.notStrictEqual(records[0].requestId, records[1].requestId);
  });
  test("cancellation records once even if pending provider work later completes", async () => {
    const app = new OpenAPIHono();
    app.use("*", usageMiddleware());
    const cancellation = new vscode.CancellationTokenSource();
    app.post("/v1/responses", async (c) => {
      const response = await sendTrackedRequest(
        model(async function* () {
          yield usage();
        }),
        [],
        {},
        cancellation.token,
      );
      cancellation.cancel();
      for await (const chunk of response.stream) {
        void chunk;
      }
      return c.text("ok");
    });
    await app.request("/v1/responses", { method: "POST" });
    cancellation.dispose();
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].outcome, "cancelled");
    assert.strictEqual(records[0].inputTokens, undefined);
  });
  test("disabled collection and failing collectors do not break proxy requests", async () => {
    const app = new OpenAPIHono();
    app.use("*", usageMiddleware());
    app.post("/v1/responses", async (c) => {
      const response = await sendTrackedRequest(
        model(async function* () {
          yield usage();
        }),
        [],
      );
      for await (const chunk of response.stream) {
        void chunk;
      }
      return c.text("ok");
    });
    configureUsageTracking(
      (row) => records.push(row),
      () => false,
    );
    assert.strictEqual(
      (await app.request("/v1/responses", { method: "POST" })).status,
      200,
    );
    assert.strictEqual(records.length, 0);
    configureUsageTracking(
      () => {
        throw new Error("storage failure");
      },
      () => true,
    );
    assert.strictEqual(
      (await app.request("/v1/responses", { method: "POST" })).status,
      200,
    );
  });
  test("failed streams keep reported usage and propagate the error", async () => {
    const app = new OpenAPIHono();
    app.use("*", usageMiddleware());
    app.post("/v1/responses", async (c) => {
      const response = await sendTrackedRequest(
        model(async function* () {
          yield usage();
          throw new Error("test failure");
        }),
        [],
      );
      await assert.rejects(async () => {
        for await (const chunk of response.stream) {
          void chunk;
        }
      }, /test failure/);
      return c.text("ok");
    });
    await app.request("/v1/responses", { method: "POST" });
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].outcome, "failed");
    assert.strictEqual(records[0].inputTokens, 100);
  });
  test("multiple model rounds retain one request/session without dropping usage", async () => {
    const app = new OpenAPIHono();
    app.use("*", usageMiddleware());
    app.post("/v1/responses", async (c) => {
      for (let i = 0; i < 2; i++) {
        const response = await sendTrackedRequest(
          model(async function* () {
            yield usage();
          }),
          [],
          { modelOptions: { _conversationId: "cache-session" } },
        );
        for await (const chunk of response.stream) {
          void chunk;
        }
      }
      return c.text("ok");
    });
    await app.request("/v1/responses", { method: "POST" });
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].requestId, records[1].requestId);
    assert.notStrictEqual(records[0].id, records[1].id);
    assert.strictEqual(records[0].sessionId, "cache-session");
    assert.strictEqual(
      records.reduce((n, r) => n + r.inputTokens!, 0),
      200,
    );
  });
  test("provider rejection before returning a stream is recorded as failure", async () => {
    const app = new OpenAPIHono();
    app.use("*", usageMiddleware());
    app.post("/v1/responses", async (c) => {
      const client = model(async function* () {});
      client.sendRequest = async () => {
        throw new Error("provider rejected");
      };
      await assert.rejects(sendTrackedRequest(client, []), /provider rejected/);
      return c.text("ok");
    });
    await app.request("/v1/responses", { method: "POST" });
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].outcome, "failed");
  });
});
