import { OpenAPIHono } from "@hono/zod-openapi";

import { registerOpenaiChatRoutes } from "./openaiChatRoutes";
import { registerOpenaiModelsRoutes } from "./openaiModelsRoutes";
import { registerOpenaiResponsesRoutes } from "./openaiResponsesRoutes";

export function registerOpenaiRoutes(app: OpenAPIHono) {
  registerOpenaiModelsRoutes(app);
  registerOpenaiChatRoutes(app);
  registerOpenaiResponsesRoutes(app);
}
