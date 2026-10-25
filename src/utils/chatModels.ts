import * as vscode from "vscode";

import { readConfiguration } from "./config";
import { logger } from "./logger";
import {
  isQualifiedModelId,
  modelRouteId,
  resolveQualifiedModel,
} from "./modelIdentity";

const SUPPORTED_VENDOR = "copilot";
const warnedUnavailableFallbackModelIds = new Set<string>();

async function selectSupportedModels(
  snapshot?: vscode.LanguageModelChat[],
): Promise<vscode.LanguageModelChat[]> {
  const allModels = snapshot ?? (await vscode.lm.selectChatModels());
  const supported = allModels;

  const col = (s: string, w: number) =>
    s.length > w ? s.slice(0, w - 3) + "..." : s.padEnd(w);
  const colW = { proxy: 6, name: 36, id: 28, vendor: 15, tokens: 15 };
  const header = `  ${col("Proxy", colW.proxy)} ${col("Name", colW.name)} ${col("ID", colW.id)} ${col("Vendor", colW.vendor)} ${col("MaxInputTokens", colW.tokens)}`;
  const divider = `  ${"-".repeat(colW.proxy)} ${"-".repeat(colW.name)} ${"-".repeat(colW.id)} ${"-".repeat(colW.vendor)} ${"-".repeat(colW.tokens)}`;
  const rows = allModels.map((m) => {
    const eligible = true;
    return `  ${col(`[${eligible ? "x" : " "}]`, colW.proxy)} ${col(m.name, colW.name)} ${col(m.id, colW.id)} ${col(m.vendor, colW.vendor)} ${m.maxInputTokens}`;
  });
  logger.info(
    `Available models (${allModels.length} total, ${supported.length} proxy-eligible):\n` +
      [header, divider, ...rows].join("\n"),
  );

  return supported;
}

class ChatModelsCache {
  private static instance: ChatModelsCache;
  private cachedModels: vscode.LanguageModelChat[] = [];
  private initializationPromise: Promise<void> | null = null;
  private hasShownNoClaudeWarning = false;

  private constructor() {}

  static getInstance(): ChatModelsCache {
    if (!ChatModelsCache.instance) {
      ChatModelsCache.instance = new ChatModelsCache();
    }
    return ChatModelsCache.instance;
  }

  async initialize(): Promise<void> {
    if (this.cachedModels.length > 0) {
      return;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      try {
        logger.info("Initializing chat models cache...");
        this.cachedModels = await selectSupportedModels();

        // Check for Claude models availability and show warning once if none found
        if (this.cachedModels.length > 0 && !this.hasShownNoClaudeWarning) {
          const hasClaudeModels = this.cachedModels.some((m) =>
            m.id.toLowerCase().includes("claude"),
          );
          if (!hasClaudeModels) {
            this.hasShownNoClaudeWarning = true;
            vscode.window.showWarningMessage(
              "No Claude models found. Please check your network or VPN settings.",
            );
          }
        }
      } catch (error) {
        logger.error("Failed to initialize chat models cache:", error);
        this.cachedModels = [];
      } finally {
        this.initializationPromise = null;
      }
    })();

    return this.initializationPromise;
  }

  async getChatModels(): Promise<vscode.LanguageModelChat[]> {
    if (this.initializationPromise) {
      await this.initializationPromise;
    }
    if (this.cachedModels.length > 0) {
      return this.cachedModels;
    }

    await this.initialize();
    return this.cachedModels;
  }

  async refresh(snapshot?: vscode.LanguageModelChat[]): Promise<void> {
    if (this.initializationPromise) {
      await this.initializationPromise;
      if (snapshot === undefined) {
        return;
      }
      this.cachedModels = await selectSupportedModels(snapshot);
      return;
    }
    this.initializationPromise = (async () => {
      try {
        this.cachedModels = await selectSupportedModels(snapshot);
      } finally {
        this.initializationPromise = null;
      }
    })();
    await this.initializationPromise;
  }

  getCachedModels(): vscode.LanguageModelChat[] {
    return this.cachedModels;
  }
}

export const chatModelsCache = ChatModelsCache.getInstance();

// `maxOutputTokens` and `capabilities` are present at runtime on Copilot
// models but only added to the `LanguageModelChat` type in newer @types/vscode
// versions. Read them defensively so we get the values when available without
// breaking typecheck against older type definitions.
//
// Note on capability field names: the VS Code API type declarations use
// `imageInput` and `toolCalling`, but Copilot's runtime exposes them as
// `supportsImageToText` and `supportsToolCalling`. Include both variants so
// we pick up the real values regardless of which provider is in use.
type LanguageModelChatWithCapabilities = vscode.LanguageModelChat & {
  maxOutputTokens?: number;
  capabilities?: {
    // VS Code API names
    imageInput?: boolean;
    toolCalling?: boolean | number;
    // Copilot runtime names
    supportsImageToText?: boolean;
    supportsToolCalling?: boolean;
  };
};

const chatModelToQuickPickItem = (
  model: LanguageModelChatWithCapabilities,
) => ({
  label: model.name,
  description: `${model.vendor} - ${model.id}`,
  modelId: modelRouteId(model),
  maxInputTokens: model.maxInputTokens,
  maxOutputTokens: model.maxOutputTokens,
  capabilities: model.capabilities,
});

export type ModelFamily = "claude" | "gemini" | "openai" | "other";

export interface GetChatModelsOptions {
  recommendedModelId?: string;
  priorityFamily?: "claude" | "gemini" | "openai";
}

function getFamilyOrder(
  priorityFamily?: "claude" | "gemini" | "openai",
): ModelFamily[] {
  const defaultOrder: ModelFamily[] = ["claude", "openai", "gemini", "other"];

  if (!priorityFamily) {
    return defaultOrder;
  }

  // Move priority family to front, but keep "other" always at the end
  return [
    priorityFamily,
    ...defaultOrder.filter((f) => f !== priorityFamily && f !== "other"),
    "other",
  ];
}

function getFamilyLabel(family: ModelFamily): string {
  const labels: Record<ModelFamily, string> = {
    claude: "Claude",
    openai: "OpenAI",
    gemini: "Gemini",
    other: "Other",
  };
  return labels[family];
}

export const getChatModelsQuickPickItems = async (
  options?: GetChatModelsOptions,
) => {
  // Get available models from cache first, fallback to direct API call
  const allModels = [
    ...new Map(
      (await chatModelsCache.getChatModels()).map((model) => [
        modelRouteId(model),
        model,
      ]),
    ).values(),
  ];
  if (allModels.length === 0) {
    return [];
  }

  const modelGroups: Record<ModelFamily, vscode.LanguageModelChat[]> = {
    claude: [],
    gemini: [],
    openai: [],
    other: [],
  };
  const recommendedId = options?.recommendedModelId;
  const recommendedModel = recommendedId
    ? allModels
        .filter(
          (model) =>
            modelRouteId(model) === recommendedId ||
            (!isQualifiedModelId(recommendedId) && model.id === recommendedId),
        )
        .sort(
          (a, b) =>
            Number(b.vendor === SUPPORTED_VENDOR) -
              Number(a.vendor === SUPPORTED_VENDOR) ||
            a.vendor.localeCompare(b.vendor) ||
            modelRouteId(a).localeCompare(modelRouteId(b)),
        )[0]
    : undefined;

  // Only one provider route becomes the recommendation; colliding raw IDs remain selectable.
  for (const m of allModels) {
    if (m === recommendedModel) {
      continue;
    } else if (m.family.includes("claude")) {
      modelGroups.claude.push(m);
    } else if (m.family.includes("gemini")) {
      modelGroups.gemini.push(m);
    } else if (m.family.includes("gpt")) {
      modelGroups.openai.push(m);
    } else {
      modelGroups.other.push(m);
    }
  }

  const modelOptions = [];

  // Add recommended model at the top if found
  if (recommendedModel) {
    modelOptions.push(
      {
        kind: vscode.QuickPickItemKind.Separator,
        label: "Recommended",
        modelId: "",
        maxInputTokens: 0,
      },
      {
        ...chatModelToQuickPickItem(recommendedModel),
        label: `${recommendedModel.name}`,
      },
    );
  }

  // Add model families in order based on priority
  const familyOrder = getFamilyOrder(options?.priorityFamily);

  for (const family of familyOrder) {
    const models = modelGroups[family];
    if (models.length > 0) {
      models.sort((a, b) =>
        b.name.localeCompare(a.name, undefined, { numeric: true }),
      );
      modelOptions.push(
        {
          kind: vscode.QuickPickItemKind.Separator,
          label: getFamilyLabel(family),
          modelId: "",
          maxInputTokens: 0,
        },
        ...models.map(chatModelToQuickPickItem),
      );
    }
  }

  return modelOptions;
};

export type CopilotReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | (string & {});

export interface CopilotModelConfiguration {
  /** Prompt/input token budget used by Copilot for this request. */
  contextSize?: number;
  /** Thinking/reasoning effort level, validated by Copilot against the selected model. */
  reasoningEffort?: CopilotReasoningEffort;
  [key: string]: unknown;
}

interface ChatRequestOptionsWithConfig
  extends vscode.LanguageModelChatRequestOptions {
  configuration?: CopilotModelConfiguration;
}

export function getCopilotModelConfiguration({
  reasoningEffort,
}: {
  reasoningEffort?: unknown;
}): CopilotModelConfiguration {
  const configuration: CopilotModelConfiguration = {};
  if (typeof reasoningEffort === "string" && reasoningEffort.trim()) {
    configuration.reasoningEffort = reasoningEffort.trim();
  }
  return configuration;
}

/**
 * Copilot derives the upstream `prompt_cache_key` from
 * `modelOptions._conversationId`; without it, requests from the same client
 * session are not routed to a shared prompt cache.
 */
export function withCopilotConversationId(
  modelOptions: Record<string, unknown>,
  promptCacheKey: unknown,
): Record<string, unknown> {
  // The key is an opaque client identifier, so forward it verbatim.
  if (typeof promptCacheKey === "string" && promptCacheKey.trim()) {
    modelOptions._conversationId = promptCacheKey;
  }
  return modelOptions;
}

/**
 * VS Code stores provider-specific model configuration separately from public
 * `modelOptions`. Copilot reads this bag for settings like context size and
 * reasoning effort.
 */
export function withCopilotConfiguration(
  client: vscode.LanguageModelChat,
  options: vscode.LanguageModelChatRequestOptions,
  configuration: CopilotModelConfiguration = {},
): vscode.LanguageModelChatRequestOptions {
  if (client.vendor !== SUPPORTED_VENDOR || client.maxInputTokens <= 0) {
    return options;
  }

  // Copilot treats contextSize as the prompt/input budget; response tokens stay
  // controlled separately by max_tokens/max_output_tokens in modelOptions.
  const contextSize = client.maxInputTokens;
  const copilotConfiguration: CopilotModelConfiguration = {
    ...configuration,
    contextSize,
  };

  logger.debug(
    `Setting Copilot configuration for ${client.id}: contextSize=${copilotConfiguration.contextSize}, reasoningEffort=${copilotConfiguration.reasoningEffort ?? "default"}`,
  );

  return {
    ...options,
    configuration: copilotConfiguration,
  } as ChatRequestOptionsWithConfig;
}

/**
 * Calculate Jaccard similarity between two strings based on character bigrams
 */
export function jaccardSimilarity(str1: string, str2: string): number {
  const getBigrams = (str: string): Set<string> => {
    const bigrams = new Set<string>();
    const normalized = str.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (let i = 0; i < normalized.length - 1; i++) {
      bigrams.add(normalized.substring(i, i + 2));
    }
    return bigrams;
  };

  const bigrams1 = getBigrams(str1);
  const bigrams2 = getBigrams(str2);

  if (bigrams1.size === 0 && bigrams2.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const bigram of bigrams1) {
    if (bigrams2.has(bigram)) {
      intersection++;
    }
  }

  const union = bigrams1.size + bigrams2.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Find the best matching model using Jaccard similarity
 */
function findBestMatch(
  modelId: string,
  models: vscode.LanguageModelChat[],
): vscode.LanguageModelChat | null {
  if (models.length === 0) {
    return null;
  }

  let bestMatch: vscode.LanguageModelChat | null = null;
  let bestScore = 0;

  for (const model of models) {
    const score = jaccardSimilarity(modelId, model.id);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = model;
    }
  }

  // Only accept matches with a reasonable similarity threshold
  if (bestScore >= 0.3 && bestMatch) {
    logger.info(
      `Fuzzy matched model "${modelId}" to "${bestMatch.id}" (similarity: ${bestScore.toFixed(2)})`,
    );
    return bestMatch;
  }

  return null;
}

/**
 * Get chat model client with integrated model mapping logic
 *
 * This function handles:
 * 1. Exact match lookup
 * 2. Fuzzy matching using Jaccard similarity
 * 3. Configured fallback model
 * 4. Fallback to "auto" or first available model
 *
 * Model registration events refresh the cache. Requests do not trigger discovery.
 * Qualified vendor routes require exact matches; legacy fuzzy routing stays Copilot-only.
 */
export const getChatModelClient = async (modelId: string) => {
  const models = await chatModelsCache.getChatModels();

  if (isQualifiedModelId(modelId)) {
    const qualified = resolveQualifiedModel(modelId, models);
    return qualified
      ? { client: qualified }
      : {
          error: {
            error: {
              message: `Qualified VS Code model '${modelId}' is unavailable`,
              type: "invalid_request_error",
            },
          },
        };
  }
  const matches = models.filter((model) => model.id === modelId);
  let client = matches.find((model) => model.vendor === SUPPORTED_VENDOR);
  if (!client && new Set(matches.map((model) => model.vendor)).size > 1) {
    return {
      error: {
        error: {
          message: `Model '${modelId}' is ambiguous; use its qualified VS Code route ID`,
          type: "invalid_request_error",
        },
      },
    };
  }
  client ??= matches[0];
  if (client) {
    return { client };
  }

  const fuzzyMatch = findBestMatch(
    modelId,
    models.filter((model) => model.vendor === SUPPORTED_VENDOR),
  );
  if (fuzzyMatch) {
    return { client: fuzzyMatch };
  }

  const fallbackModelId = readConfiguration().fallbackModelId.trim();
  if (fallbackModelId) {
    client = models.find((model) => modelRouteId(model) === fallbackModelId);
    if (client) {
      warnedUnavailableFallbackModelIds.delete(fallbackModelId);
      logger.info(
        `Model "${modelId}" not found, using configured fallback model: ${client.id}`,
      );
      return { client };
    }
    if (!warnedUnavailableFallbackModelIds.has(fallbackModelId)) {
      warnedUnavailableFallbackModelIds.add(fallbackModelId);
      logger.warn(
        `Configured fallback model "${fallbackModelId}" is unavailable; continuing with automatic fallback`,
      );
    }
  }

  const autoModel = models.find((model) => model.id === "auto");
  if (autoModel) {
    logger.info(`Model "${modelId}" not found, using auto model`);
    return { client: autoModel };
  }

  if (models.length > 0) {
    const fallback = models[0];
    logger.info(
      `Model "${modelId}" not found, using first available model: ${fallback.id}`,
    );
    return { client: fallback };
  }

  // No models available at all
  logger.error(`No VS Code LM model available for model ID: ${modelId}`);
  return {
    error: {
      error: {
        message: `Model '${modelId}' not found and no fallback models available. Use /api/v1/lm/chatModels to list available models.`,
        type: "invalid_request_error",
      },
    },
  };
};
