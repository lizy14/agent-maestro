import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import * as vscode from "vscode";

import { chatModelsCache } from "../../../utils/chatModels";
import {
  createOpenAIModelsResponse,
  findOpenAIModelById,
  openAIModelSchema,
  openAIModelsResponseSchema,
} from "../../utils/openaiModels";

const openAIErrorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.string().nullable(),
    code: z.string().nullable(),
  }),
});

const modelsRoute = createRoute({
  method: "get",
  path: "/v1/models",
  tags: ["OpenAI API"],
  summary: "List models with OpenAI-compatible API",
  description:
    "List available VS Code Language Models in OpenAI-compatible /models format.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: openAIModelsResponseSchema,
        },
      },
      description: "Successfully listed available models",
    },
    500: {
      content: {
        "application/json": {
          schema: openAIErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

const modelRoute = createRoute({
  method: "get",
  path: "/v1/models/{model_id}",
  tags: ["OpenAI API"],
  summary: "Retrieve model with OpenAI-compatible API",
  description:
    "Retrieve a single VS Code Language Model in OpenAI-compatible /models format.",
  request: {
    params: z.object({
      model_id: z.string().describe("The model ID to retrieve"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: openAIModelSchema,
        },
      },
      description: "Successfully retrieved model",
    },
    404: {
      content: {
        "application/json": {
          schema: openAIErrorResponseSchema,
        },
      },
      description: "Model not found",
    },
    500: {
      content: {
        "application/json": {
          schema: openAIErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

export function registerOpenaiModelsRoutes(
  app: OpenAPIHono,
  getModels: () => Promise<vscode.LanguageModelChat[]> = () =>
    chatModelsCache.getChatModels(),
) {
  app.openapi(modelsRoute, async (c) => {
    try {
      const models = await getModels();
      return c.json(createOpenAIModelsResponse(models), 200);
    } catch (error) {
      return c.json(
        {
          error: {
            message:
              error instanceof Error ? error.message : "Failed to list models",
            type: "server_error",
            param: null,
            code: "server_error",
          },
        },
        500,
      );
    }
  });

  app.openapi(modelRoute, async (c) => {
    try {
      const { model_id: modelId } = c.req.valid("param");
      const models = await getModels();
      const model = findOpenAIModelById(models, modelId);

      if (!model) {
        return c.json(
          {
            error: {
              message: `Model '${modelId}' not found`,
              type: "invalid_request_error",
              param: "model_id",
              code: "model_not_found",
            },
          },
          404,
        );
      }

      return c.json(model, 200);
    } catch (error) {
      return c.json(
        {
          error: {
            message:
              error instanceof Error
                ? error.message
                : "Failed to retrieve model",
            type: "server_error",
            param: null,
            code: "server_error",
          },
        },
        500,
      );
    }
  });
}
