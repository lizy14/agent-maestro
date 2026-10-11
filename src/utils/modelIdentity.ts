import * as vscode from "vscode";

const PREFIX = "vscode-lm-";
export function modelRouteId(
  model: Pick<vscode.LanguageModelChat, "vendor" | "id">,
): string {
  return model.vendor === "copilot" && !model.id.startsWith(PREFIX)
    ? model.id
    : `${PREFIX}${Buffer.from(JSON.stringify([model.vendor, model.id]), "utf8").toString("base64url")}`;
}
export function resolveQualifiedModel(
  id: string,
  models: vscode.LanguageModelChat[],
): vscode.LanguageModelChat | undefined {
  if (!id.startsWith(PREFIX)) {
    return undefined;
  }
  return models.find(
    (model) =>
      modelRouteId(model) === id || `${modelRouteId(model)}[1m]` === id,
  );
}
export function isQualifiedModelId(id: string): boolean {
  return id.startsWith(PREFIX);
}
