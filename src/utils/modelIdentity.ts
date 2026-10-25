import * as vscode from "vscode";

const PREFIX = "vscode-lm-";
const ANTHROPIC_ALIAS_PREFIX = `anthropic-${PREFIX}`;

export function modelDisplayName(
  model: Pick<vscode.LanguageModelChat, "name" | "vendor" | "id">,
): string {
  const suffix = " (Agent Maestro)";
  const name = model.name.endsWith(suffix)
    ? model.name.slice(0, -suffix.length)
    : model.name;
  const internal =
    model.id.startsWith("copilot-utility") ||
    model.id.startsWith("copilot-dictation-");
  const qualifier = internal
    ? ` [internal alias: ${model.id}]`
    : model.vendor !== "copilot"
      ? ` [${model.vendor}: ${model.id}]`
      : "";
  return `${name}${qualifier}${suffix}`;
}

export function modelNotificationLabel(
  model: Pick<vscode.LanguageModelChat, "name" | "vendor" | "id">,
): string {
  return `${model.name} [${model.vendor} / ${model.id}]`;
}
export function modelRouteId(
  model: Pick<vscode.LanguageModelChat, "vendor" | "id">,
): string {
  return model.vendor === "copilot" &&
    !model.id.startsWith(PREFIX) &&
    !model.id.startsWith(ANTHROPIC_ALIAS_PREFIX)
    ? model.id
    : `${PREFIX}${Buffer.from(JSON.stringify([model.vendor, model.id]), "utf8").toString("base64url")}`;
}
/** Claude gateway discovery filters IDs unless they contain "claude" or "anthropic". */
export function anthropicModelRouteId(
  model: Pick<vscode.LanguageModelChat, "vendor" | "id">,
): string {
  const routeId = modelRouteId(model);
  if (
    routeId === model.id &&
    !routeId.startsWith(ANTHROPIC_ALIAS_PREFIX) &&
    /claude|anthropic/i.test(routeId)
  ) {
    return routeId;
  }
  const qualified = routeId.startsWith(PREFIX)
    ? routeId
    : `${PREFIX}${Buffer.from(JSON.stringify([model.vendor, model.id]), "utf8").toString("base64url")}`;
  return `anthropic-${qualified}`;
}

export function resolveQualifiedModel(
  id: string,
  models: vscode.LanguageModelChat[],
): vscode.LanguageModelChat | undefined {
  if (!isQualifiedModelId(id)) {
    return undefined;
  }
  return models.find((model) => {
    const route = id.startsWith(ANTHROPIC_ALIAS_PREFIX)
      ? anthropicModelRouteId(model)
      : modelRouteId(model);
    return route === id || `${route}[1m]` === id;
  });
}
export function isQualifiedModelId(id: string): boolean {
  return id.startsWith(PREFIX) || id.startsWith(ANTHROPIC_ALIAS_PREFIX);
}
