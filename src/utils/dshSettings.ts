import * as os from "os";
import * as path from "path";

const AGENT_MAESTRO_DSH_PROVIDER = "agent-maestro";
export const DSH_MANAGED_BLOCK_START = "# >>> Agent Maestro DSH provider >>>";
export const DSH_MANAGED_BLOCK_END = "# <<< Agent Maestro DSH provider <<<";
export type DshConfigFormat = "profile-patch" | "legacy-settings";

function getDshHome(): string {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
  return path.resolve(
    home === "~"
      ? os.homedir()
      : /^~[\\/]/.test(home)
        ? path.join(os.homedir(), home.slice(2))
        : home,
  );
}

export function getDshSettingsPath(): string {
  return path.join(getDshHome(), "settings.yaml");
}

export function getDshPatchPath(profile = "desktop"): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) {
    throw new Error(
      "Use a profile name containing only letters, numbers, underscores, and hyphens.",
    );
  }
  return path.join(getDshHome(), "profiles", profile, "cordis.patch.yml");
}

// JSON strings are valid YAML scalars, including escaped control characters.
function yamlString(value: string): string {
  return JSON.stringify(value);
}

export interface DshModelConfig {
  modelId: string;
  modelName?: string;
  modelContextWindow?: number;
  modelMaxOutputTokens?: number;
  modelInput?: ("text" | "image")[];
}

export function createDshManagedBlock(
  params: DshModelConfig & {
    baseURL: string;
    models?: DshModelConfig[];
    format?: DshConfigFormat;
  },
): string {
  const models = params.models ?? [params];
  if (
    !models.length ||
    !models.some((model) => model.modelId === params.modelId)
  ) {
    throw new Error(
      "The default model must belong to a nonempty model catalog.",
    );
  }
  const ids = new Set<string>();
  for (const model of models) {
    if (!model.modelId || ids.has(model.modelId)) {
      throw new Error("Model catalog IDs must be nonempty and unique.");
    }
    ids.add(model.modelId);
    if (
      model.modelContextWindow !== undefined &&
      (!Number.isSafeInteger(model.modelContextWindow) ||
        model.modelContextWindow <= 0)
    ) {
      throw new Error("Model context window must be a positive safe integer.");
    }
    if (
      model.modelMaxOutputTokens !== undefined &&
      (!Number.isSafeInteger(model.modelMaxOutputTokens) ||
        model.modelMaxOutputTokens <= 0)
    ) {
      throw new Error("Model output limit must be a positive safe integer.");
    }
    if (
      model.modelInput !== undefined &&
      (!model.modelInput.length ||
        model.modelInput.some((input) => input !== "text" && input !== "image"))
    ) {
      throw new Error("Model input must contain text and/or image.");
    }
  }
  const legacy = params.format === "legacy-settings";
  const indent = legacy ? "        " : "          ";
  const catalog = models
    .map((model) => {
      const fields = [`${indent}- id: ${yamlString(model.modelId)}`];
      if (model.modelName) {
        fields.push(`${indent}  name: ${yamlString(model.modelName)}`);
      }
      if (legacy) {
        fields.push(
          `${indent}  input:`,
          ...(model.modelInput ?? ["text"]).map(
            (input) => `${indent}    - ${input}`,
          ),
        );
      }
      if (model.modelContextWindow !== undefined) {
        fields.push(`${indent}  contextWindow: ${model.modelContextWindow}`);
      }
      if (model.modelMaxOutputTokens !== undefined) {
        fields.push(`${indent}  maxTokens: ${model.modelMaxOutputTokens}`);
      }
      if (!legacy && model.modelInput !== undefined) {
        fields.push(
          `${indent}  input:`,
          ...model.modelInput.map((input) => `${indent}    - ${input}`),
        );
      }
      return fields.join("\n");
    })
    .join("\n");
  if (legacy) {
    return `${DSH_MANAGED_BLOCK_START}\nllm-pi-ai:\n  providers:\n    ${AGENT_MAESTRO_DSH_PROVIDER}:\n      apiKeyEnv: AGENT_MAESTRO_API_KEY\n      api: openai-responses\n      baseURL: ${yamlString(params.baseURL)}\n      models:\n${catalog}\n${DSH_MANAGED_BLOCK_END}`;
  }
  const baseURL = `${params.baseURL.replace(/\/+$/, "")}/`;
  return `${DSH_MANAGED_BLOCK_START}\n- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      ${AGENT_MAESTRO_DSH_PROVIDER}:\n        displayName: "Agent Maestro"\n        apiKeyEnv: AGENT_MAESTRO_API_KEY\n        api: openai-completions\n        baseURL: ${yamlString(baseURL)}\n        models:\n${catalog}\n- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: ${AGENT_MAESTRO_DSH_PROVIDER}\n    model: ${yamlString(params.modelId)}\n${DSH_MANAGED_BLOCK_END}`;
}

export function updateDshSettingsContent(
  existingContent: string,
  managedBlock: string,
  format: DshConfigFormat = "profile-patch",
): { content: string; blockedByExistingLlmPiAi: boolean } {
  const blocked = { content: existingContent, blockedByExistingLlmPiAi: true };
  const lines = existingContent.split(/\r?\n/);
  const starts = lines.flatMap((line, index) =>
    line === DSH_MANAGED_BLOCK_START ? [index] : [],
  );
  const ends = lines.flatMap((line, index) =>
    line === DSH_MANAGED_BLOCK_END ? [index] : [],
  );
  if (
    starts.length !== ends.length ||
    starts.length > 1 ||
    (starts.length === 1 && starts[0] >= ends[0]) ||
    lines.some(
      (line) =>
        (line.includes(DSH_MANAGED_BLOCK_START) ||
          line.includes(DSH_MANAGED_BLOCK_END)) &&
        line !== DSH_MANAGED_BLOCK_START &&
        line !== DSH_MANAGED_BLOCK_END,
    )
  ) {
    return blocked;
  }

  const unmanaged = starts.length
    ? [...lines.slice(0, starts[0]), ...lines.slice(ends[0] + 1)].join("\n")
    : existingContent;
  if (format === "legacy-settings") {
    if (/^\s*["']?llm-pi-ai["']?\s*:/m.test(unmanaged)) {
      return blocked;
    }
  } else {
    // Cordis permits executable YAML and whole-config replacements. Without a
    // parser, never alter any unmanaged executable content, even unrelated IDs.
    const activeLines = unmanaged
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
    if (
      !starts.length &&
      activeLines.length &&
      !(activeLines.length === 1 && activeLines[0].trim() === "[]")
    ) {
      return blocked;
    }
    if (starts.length) {
      // Updating an owned block does not parse or rewrite surrounding YAML.
      // Reject additional target overrides, including escaped JSON scalars.
      if (
        activeLines.length &&
        !activeLines.some((line) => /^-\s/.test(line))
      ) {
        return blocked;
      }
      for (const line of activeLines) {
        if (
          /^(?:---|\.\.\.)\s*$|\t|^[^\s-]|^\s*[^#]+:\s*(?:[|>]|[\[{](?!\s*[}\]]))|^\s*[^#]+:\s*[&*!]|^\s*(?:-\s*)?["'].*\\[ux]/.test(
            line,
          )
        ) {
          return blocked;
        }
        if (/^-(?:\s+[\[{&*!]|\s*(?:id|name):\s*[&*!])/.test(line)) {
          return blocked;
        }
        const field = line.match(/^\s*(?:-\s*)?(id|name):\s*(.*)$/);
        if (!field) {
          continue;
        }
        let value = field[2].replace(/\s+#.*$/, "").trim();
        if (value.startsWith('"')) {
          try {
            value = JSON.parse(value);
          } catch {
            return blocked;
          }
        } else if (value.startsWith("'")) {
          if (!/^'(?:[^']|'')*'$/.test(value)) {
            return blocked;
          }
          value = value.slice(1, -1).replace(/''/g, "'");
        }
        if (
          [
            "llm-pi-ai",
            "agent-default-model",
            "@deepseek-ai/dsh-llm-pi-ai",
            "@deepseek-ai/dsh-agent-default-model",
          ].includes(value)
        ) {
          return blocked;
        }
      }
      const ownedLines = lines.slice(starts[0] + 1, ends[0]);
      const pluginIds = ownedLines.filter((line) => /^-/.test(line));
      if (
        pluginIds.length !== 2 ||
        pluginIds[0] !== "- id: llm-pi-ai" ||
        pluginIds[1] !== "- id: agent-default-model"
      ) {
        return blocked;
      }
    }
  }

  const newline = existingContent.includes("\r\n") ? "\r\n" : "\n";
  const block = managedBlock.replace(/\r?\n/g, newline);
  if (starts.length) {
    const updated = [
      ...lines.slice(0, starts[0]),
      block,
      ...lines.slice(ends[0] + 1),
    ];
    return { content: updated.join(newline), blockedByExistingLlmPiAi: false };
  }
  const content =
    format === "profile-patch"
      ? existingContent.replace(/^\s*\[\]\s*$/m, "")
      : existingContent;
  const prefix =
    content.trim().length === 0
      ? content
      : `${content.trimEnd()}${newline}${newline}`;
  return {
    content: `${prefix}${block}${newline}`,
    blockedByExistingLlmPiAi: false,
  };
}
