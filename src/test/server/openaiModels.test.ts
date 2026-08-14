import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import * as vscode from "vscode";

import { registerOpenaiModelsRoutes } from "../../server/routes/openai/openaiModelsRoutes";

suite("OpenAI Models Routes Test Suite", () => {
  const models = [
    { id: "gpt-test", vendor: "copilot" },
    { id: "claude-test", vendor: "copilot" },
  ] as vscode.LanguageModelChat[];

  function createApp() {
    const app = new OpenAPIHono();
    registerOpenaiModelsRoutes(app, async () => models);
    return app;
  }

  test("GET /v1/models lists available model IDs", async () => {
    const response = await createApp().request("/v1/models");
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      object: "list",
      data: [
        {
          id: "gpt-test",
          object: "model",
          created: 0,
          owned_by: "agent-maestro",
        },
        {
          id: "claude-test",
          object: "model",
          created: 0,
          owned_by: "agent-maestro",
        },
      ],
    });
  });

  test("GET /v1/models/:id returns the requested model", async () => {
    const response = await createApp().request("/v1/models/gpt-test");
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      id: "gpt-test",
      object: "model",
      created: 0,
      owned_by: "agent-maestro",
    });
  });

  test("GET /v1/models/:id returns an OpenAI-style 404", async () => {
    const response = await createApp().request("/v1/models/missing");
    assert.strictEqual(response.status, 404);
    const body = (await response.json()) as { error: { code: string } };
    assert.strictEqual(body.error.code, "model_not_found");
  });
});
