import { z } from "@hono/zod-openapi";
import * as vscode from "vscode";

const OPENAI_UNKNOWN_CREATED_AT = 0;
const OPENAI_MODEL_OWNER = "agent-maestro";

export const openAIModelSchema = z.object({
  id: z.string(),
  object: z.literal("model"),
  created: z.number().int(),
  owned_by: z.string(),
});

export const openAIModelsResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(openAIModelSchema),
});

export type OpenAIModelInfo = z.infer<typeof openAIModelSchema>;
export type OpenAIModelsResponse = z.infer<typeof openAIModelsResponseSchema>;

export function convertVSCodeModelToOpenAIModel(
  model: vscode.LanguageModelChat,
): OpenAIModelInfo {
  return {
    id: model.id,
    object: "model",
    created: OPENAI_UNKNOWN_CREATED_AT,
    owned_by: OPENAI_MODEL_OWNER,
  };
}

export function createOpenAIModelsResponse(
  models: vscode.LanguageModelChat[],
): OpenAIModelsResponse {
  return {
    object: "list",
    data: models.map(convertVSCodeModelToOpenAIModel),
  };
}

export function findOpenAIModelById(
  models: vscode.LanguageModelChat[],
  modelId: string,
): OpenAIModelInfo | null {
  const model = models.find((candidate) => candidate.id === modelId);
  return model ? convertVSCodeModelToOpenAIModel(model) : null;
}
