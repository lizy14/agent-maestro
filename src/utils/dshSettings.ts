import * as os from "os";
import * as path from "path";

const AGENT_MAESTRO_DSH_PROVIDER = "agent-maestro";
export const DSH_MANAGED_BLOCK_START = "# >>> Agent Maestro DSH provider >>>";
export const DSH_MANAGED_BLOCK_END = "# <<< Agent Maestro DSH provider <<<";

export function getDshSettingsPath(): string {
  const dshHome =
    process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
  return path.join(dshHome, "settings.yaml");
}

// JSON string literals are valid YAML double-quoted scalars and correctly
// escape quotes, backslashes, and control characters.
function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function createDshManagedBlock(params: {
  baseURL: string;
  modelId: string;
  modelContextWindow?: number;
}): string {
  const contextWindow =
    params.modelContextWindow !== undefined
      ? `\n          contextWindow: ${params.modelContextWindow}`
      : "";

  return `${DSH_MANAGED_BLOCK_START}\nllm-pi-ai:\n  providers:\n    ${AGENT_MAESTRO_DSH_PROVIDER}:\n      apiKeyEnv: AGENT_MAESTRO_API_KEY\n      api: openai-responses\n      baseURL: ${yamlString(params.baseURL)}\n      models:\n        - id: ${yamlString(params.modelId)}\n          input:\n            - text${contextWindow}\n${DSH_MANAGED_BLOCK_END}`;
}

export function updateDshSettingsContent(
  existingContent: string,
  managedBlock: string,
): { content: string; blockedByExistingLlmPiAi: boolean } {
  const startIndex = existingContent.indexOf(DSH_MANAGED_BLOCK_START);
  const endIndex = existingContent.indexOf(DSH_MANAGED_BLOCK_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const replaceEnd = endIndex + DSH_MANAGED_BLOCK_END.length;
    return {
      content: `${existingContent.slice(0, startIndex)}${managedBlock}${existingContent.slice(replaceEnd)}`,
      blockedByExistingLlmPiAi: false,
    };
  }

  // A lone marker means a previous managed block is malformed. Do not append
  // another top-level llm-pi-ai key and leave the file even harder to repair.
  if ((startIndex === -1) !== (endIndex === -1)) {
    return { content: existingContent, blockedByExistingLlmPiAi: true };
  }

  if (/^\s*llm-pi-ai\s*:/m.test(existingContent)) {
    return { content: existingContent, blockedByExistingLlmPiAi: true };
  }

  const prefix =
    existingContent.trim().length === 0
      ? ""
      : `${existingContent.trimEnd()}\n\n`;
  return {
    content: `${prefix}${managedBlock}\n`,
    blockedByExistingLlmPiAi: false,
  };
}
