import crypto from "crypto";
import { SSEStreamingApi } from "hono/streaming";
import {
  EasyInputMessage,
  FunctionTool,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputItem,
  ResponseOutputMessage,
  ResponseOutputText,
  Tool,
  ToolChoiceAllowed,
  ToolChoiceApplyPatch,
  ToolChoiceCustom,
  ToolChoiceFunction,
  ToolChoiceMcp,
  ToolChoiceOptions,
  ToolChoiceShell,
  ToolChoiceTypes,
} from "openai/resources/responses/responses";
import * as vscode from "vscode";

import { logger } from "../../utils/logger";

/**
 * Import types from OpenAI SDK for Responses API
 */
export type ToolChoice =
  | ToolChoiceOptions
  | ToolChoiceAllowed
  | ToolChoiceTypes
  | ToolChoiceFunction
  | ToolChoiceMcp
  | ToolChoiceCustom
  | ToolChoiceApplyPatch
  | ToolChoiceShell;

/**
 * Output item types for Responses API (subset we generate)
 */
export type OutputItem = ResponseOutputMessage | ResponseFunctionToolCall;

/**
 * Generate random string for IDs using crypto
 */
const randomString = (length: number): string => {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(bytes[i] % chars.length);
  }
  return result;
};

/**
 * Generate unique response ID
 */
export const generateResponseId = (): string =>
  `resp_AM-${Date.now()}-${randomString(8)}`;

/**
 * Generate unique message ID
 */
export const generateMessageId = (): string => `msg_AM-${randomString(12)}`;

/**
 * Generate unique function call ID
 */
export const generateFunctionCallId = (): string => `fc_AM-${randomString(12)}`;

/**
 * Get current Unix timestamp in seconds
 */
export const getCurrentTimestamp = (): number => Math.floor(Date.now() / 1000);

/**
 * Helper for closing a message output item in streaming responses
 */
export const closeMessageOutputItem = async (
  sseStream: SSEStreamingApi,
  messageId: string,
  outputIndex: number,
  contentIndex: number,
  accumulatedText: string,
  sequenceNumberRef?: { value: number },
): Promise<OutputItem> => {
  const nextSeq = () =>
    sequenceNumberRef ? sequenceNumberRef.value++ : undefined;

  await sseStream.writeSSE({
    event: "response.output_text.done",
    data: JSON.stringify({
      type: "response.output_text.done",
      item_id: messageId,
      output_index: outputIndex,
      content_index: contentIndex,
      text: accumulatedText,
      sequence_number: nextSeq(),
    }),
  });

  await sseStream.writeSSE({
    event: "response.content_part.done",
    data: JSON.stringify({
      type: "response.content_part.done",
      item_id: messageId,
      output_index: outputIndex,
      content_index: contentIndex,
      part: {
        type: "output_text",
        text: accumulatedText,
        annotations: [],
      },
      sequence_number: nextSeq(),
    }),
  });

  const outputItem: OutputItem = {
    type: "message",
    id: messageId,
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: accumulatedText,
        annotations: [],
      },
    ],
    status: "completed",
  };

  await sseStream.writeSSE({
    event: "response.output_item.done",
    data: JSON.stringify({
      type: "response.output_item.done",
      output_index: outputIndex,
      item: outputItem,
      sequence_number: nextSeq(),
    }),
  });

  return outputItem;
};

/**
 * Convert input_image content to VSCode DataPart or TextPart
 */
const convertInputImageToVSCodePart = (
  content: ResponseInputImage,
): vscode.LanguageModelTextPart => {
  // Access LanguageModelDataPart which is not officially exposed in types
  const LanguageModelDataPart = (vscode as any).LanguageModelDataPart;

  if (content.image_url && LanguageModelDataPart) {
    // Parse data URI: data:image/png;base64,<data>
    const match = content.image_url.match(/^data:(image\/\w+);base64,(.+)$/);
    if (match) {
      const mimeType = match[1];
      const base64Data = match[2];
      return new LanguageModelDataPart(
        Buffer.from(base64Data, "base64"),
        mimeType,
      );
    }
  }
  // URL-based images, file_id, or LanguageModelDataPart not available - fallback to JSON
  logger.warn("input_image not fully supported, serializing as JSON");
  return new vscode.LanguageModelTextPart(JSON.stringify(content));
};

/**
 * Convert a single input content part to VSCode part
 */
export const convertInputContentToVSCodePart = (
  content: ResponseInputContent | ResponseOutputText,
): vscode.LanguageModelTextPart => {
  switch (content.type) {
    case "input_text":
      return new vscode.LanguageModelTextPart(content.text ?? "");
    case "output_text":
      // Accept output_text for compatibility with persisted response content.
      return new vscode.LanguageModelTextPart(content.text ?? "");
    case "input_image":
      return convertInputImageToVSCodePart(content);
    case "input_file":
      logger.warn("input_file not supported, serializing as JSON");
      return new vscode.LanguageModelTextPart(JSON.stringify(content));
    default:
      logger.warn(
        `Unknown content type "${(content as any).type}", serializing as JSON`,
      );
      return new vscode.LanguageModelTextPart(JSON.stringify(content));
  }
};

/**
 * Check if item is an EasyInputMessage (shorthand format)
 */
const isEasyInputMessage = (item: unknown): item is EasyInputMessage => {
  return (
    typeof item === "object" &&
    item !== null &&
    "role" in item &&
    "content" in item &&
    (!("type" in item) || (item as Record<string, unknown>).type === "message")
  );
};

/**
 * Convert EasyInputMessage to VSCode LM message
 */
const convertEasyInputMessage = (
  msg: EasyInputMessage,
): vscode.LanguageModelChatMessage => {
  if (typeof msg.content === "string") {
    switch (msg.role) {
      case "user":
        return vscode.LanguageModelChatMessage.User(msg.content);
      case "assistant":
        return vscode.LanguageModelChatMessage.Assistant(msg.content);
      case "system":
      case "developer":
        return vscode.LanguageModelChatMessage.User(msg.content);
      default:
        return vscode.LanguageModelChatMessage.User(msg.content);
    }
  }

  const parts = msg.content.map(convertInputContentToVSCodePart);
  switch (msg.role) {
    case "user":
      return vscode.LanguageModelChatMessage.User(parts);
    case "assistant":
      return vscode.LanguageModelChatMessage.Assistant(parts);
    case "system":
    case "developer":
      return vscode.LanguageModelChatMessage.User(parts);
    default:
      return vscode.LanguageModelChatMessage.User(parts);
  }
};

/**
 * Convert ResponseInputItem.Message to VSCode LM message
 */
const convertInputMessage = (
  msg: ResponseInputItem.Message,
): vscode.LanguageModelChatMessage => {
  const parts = msg.content.map(convertInputContentToVSCodePart);
  switch (msg.role) {
    case "user":
      return vscode.LanguageModelChatMessage.User(parts);
    case "system":
    case "developer":
      return vscode.LanguageModelChatMessage.User(parts);
    default:
      return vscode.LanguageModelChatMessage.User(parts);
  }
};

/**
 * Convert a single input item to VSCode LM message
 */
export const convertResponsesItemToVSCode = (
  item: ResponseInputItem,
): vscode.LanguageModelChatMessage | null => {
  if (!item || typeof item !== "object") {
    return null;
  }

  const typedItem = item as unknown as Record<string, unknown>;

  // Handle function_call (ResponseFunctionToolCall)
  if (typedItem.type === "function_call") {
    const fc = item as ResponseFunctionToolCall;
    let input = {};
    try {
      input = JSON.parse(fc.arguments);
    } catch (e) {
      logger.warn("Failed to parse function_call arguments:", e);
    }
    return vscode.LanguageModelChatMessage.Assistant([
      new vscode.LanguageModelToolCallPart(fc.call_id, fc.name, input),
    ]);
  }

  // Handle function_call_output
  if (typedItem.type === "function_call_output") {
    const fco = item as ResponseInputItem.FunctionCallOutput;
    // fco.output can be string or array of content items
    const outputText =
      typeof fco.output === "string" ? fco.output : JSON.stringify(fco.output);
    return vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelToolResultPart(fco.call_id, [
        new vscode.LanguageModelTextPart(outputText),
      ]),
    ]);
  }

  // Handle custom_tool_call
  if (typedItem.type === "custom_tool_call") {
    const ctc = typedItem as {
      call_id?: string;
      id?: string;
      name?: string;
      input?: string;
    };

    const callId = ctc.call_id || ctc.id || "";
    const toolName = ctc.name || "custom_tool";
    let input: Record<string, unknown> = {};

    if (typeof ctc.input === "string") {
      try {
        const parsed = JSON.parse(ctc.input);
        input =
          parsed && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : { input: parsed };
      } catch {
        // Custom tool input can be plain text, not only JSON.
        input = { input: ctc.input };
      }
    }

    return vscode.LanguageModelChatMessage.Assistant([
      new vscode.LanguageModelToolCallPart(callId, toolName, input),
    ]);
  }

  // Handle custom_tool_call_output
  if (typedItem.type === "custom_tool_call_output") {
    const ctco = typedItem as {
      call_id?: string;
      id?: string;
      output?: unknown;
    };
    const callId = ctco.call_id || ctco.id || "";
    const outputText =
      typeof ctco.output === "string"
        ? ctco.output
        : JSON.stringify(ctco.output ?? typedItem);

    return vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelToolResultPart(callId, [
        new vscode.LanguageModelTextPart(outputText),
      ]),
    ]);
  }

  // Handle built-in tool calls (local_shell_call, shell_call, apply_patch_call)
  // Convert them to equivalent LanguageModelToolCallPart messages
  if (
    typedItem.type === "local_shell_call" ||
    typedItem.type === "shell_call" ||
    typedItem.type === "apply_patch_call"
  ) {
    const callId =
      (typedItem.call_id as string) || (typedItem.id as string) || "";
    const toolName =
      typedItem.type === "apply_patch_call" ? "apply_patch" : "shell";
    // Extract the action/arguments from the built-in call
    let input: Record<string, unknown> = {};
    if (typedItem.action && typeof typedItem.action === "object") {
      input = typedItem.action as Record<string, unknown>;
    } else if (typedItem.operation && typeof typedItem.operation === "object") {
      // apply_patch_call payloads use "operation" in OpenAI Responses API.
      input = typedItem.operation as Record<string, unknown>;
    } else if (typedItem.patch && typeof typedItem.patch === "string") {
      input = { patch: typedItem.patch };
    }
    return vscode.LanguageModelChatMessage.Assistant([
      new vscode.LanguageModelToolCallPart(callId, toolName, input),
    ]);
  }

  // Handle built-in tool call outputs (local_shell_call_output, shell_call_output, apply_patch_call_output)
  if (
    typedItem.type === "local_shell_call_output" ||
    typedItem.type === "shell_call_output" ||
    typedItem.type === "apply_patch_call_output"
  ) {
    const callId =
      (typedItem.call_id as string) || (typedItem.id as string) || "";
    const outputText =
      typeof typedItem.output === "string"
        ? (typedItem.output as string)
        : JSON.stringify(typedItem.output ?? typedItem);
    return vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelToolResultPart(callId, [
        new vscode.LanguageModelTextPart(outputText),
      ]),
    ]);
  }

  // Handle EasyInputMessage (has role and content, type is optional or "message")
  if (isEasyInputMessage(item)) {
    return convertEasyInputMessage(item as EasyInputMessage);
  }

  // Handle full InputMessage (ResponseInputItem.Message)
  if (typedItem.type === "message" && "content" in typedItem) {
    return convertInputMessage(item as unknown as ResponseInputItem.Message);
  }

  logger.warn("Unsupported input item type, skipping:", typedItem.type);
  return null;
};

/**
 * Convert Responses API input to VSCode LM messages
 */
export const convertResponsesInputToVSCode = (
  input: string | ResponseInput | undefined,
  instruction?: string | ResponseInput | null,
): vscode.LanguageModelChatMessage[] => {
  const messages: vscode.LanguageModelChatMessage[] = [];

  // Add instruction as first user message if present
  if (instruction) {
    if (typeof instruction === "string") {
      messages.push(vscode.LanguageModelChatMessage.User(instruction));
    } else if (Array.isArray(instruction)) {
      for (const item of instruction) {
        const converted = convertResponsesItemToVSCode(item);
        if (converted) {
          messages.push(converted);
        }
      }
    }
  }

  // Handle string input
  if (typeof input === "string") {
    messages.push(vscode.LanguageModelChatMessage.User(input));
    return messages;
  }

  // Handle array input
  if (Array.isArray(input)) {
    for (const item of input) {
      const converted = convertResponsesItemToVSCode(item);
      if (converted) {
        messages.push(converted);
      }
    }
  }

  return messages;
};

/**
 * Convert Responses API tools to VSCode LM tools.
 * Built-in tool types (local_shell, shell, apply_patch, custom) are converted
 * to function tool equivalents so the VSCode LM can use them.
 */
export const convertResponsesToolsToVSCode = (
  tools?: Tool[],
): vscode.LanguageModelChatTool[] => {
  if (!tools) {
    return [];
  }

  const vsCodeTools: vscode.LanguageModelChatTool[] = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }

    if (tool.type === "function") {
      const funcTool = tool as FunctionTool;

      vsCodeTools.push({
        name: funcTool.name,
        description: funcTool.description ?? "",
        inputSchema: funcTool.parameters ?? undefined,
      });
    } else {
      // Convert built-in tool types to function equivalents
      const builtinTool = convertBuiltinToolToFunction(tool);
      if (builtinTool) {
        vsCodeTools.push(builtinTool);
      } else {
        logger.debug(`Tool type "${tool.type}" not supported, skipping`);
      }
    }
  }

  return vsCodeTools;
};

/**
 * Convert a built-in Responses API tool type to an equivalent VSCode LM
 * function tool. Returns null for unsupported tool types.
 */
const convertBuiltinToolToFunction = (
  tool: Tool,
): vscode.LanguageModelChatTool | null => {
  const type = (tool as { type: string }).type;

  switch (type) {
    case "local_shell":
      return {
        name: "shell",
        description:
          "Runs a shell command on the user's machine and returns the output. Use this to execute commands, run scripts, install packages, etc.",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "array",
              items: { type: "string" },
              description:
                'The command to run as an array of strings (e.g. ["ls", "-la"])',
            },
            working_directory: {
              type: "string",
              description: "The working directory for the command",
            },
            timeout_ms: {
              type: "number",
              description:
                "Optional timeout in milliseconds for the command (default: 600000)",
            },
          },
          required: ["command"],
        },
      };

    case "shell":
      return {
        name: "shell",
        description:
          "Runs a shell command on the user's machine and returns the output.",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "array",
              items: { type: "string" },
              description: "The command to run as an array of strings",
            },
            working_directory: {
              type: "string",
              description: "The working directory for the command",
            },
            timeout_ms: {
              type: "number",
              description: "Optional timeout in milliseconds",
            },
          },
          required: ["command"],
        },
      };

    case "apply_patch":
      return {
        name: "apply_patch",
        description:
          "Applies a patch to files on the user's machine. Use unified diff format to create, modify, or delete files.",
        inputSchema: {
          type: "object",
          properties: {
            patch: {
              type: "string",
              description:
                "The patch content in unified diff format to apply to files",
            },
          },
          required: ["patch"],
        },
      };

    case "custom": {
      // Custom tools expose input constraints via `format` in OpenAI Responses API.
      // Keep a fallback to legacy `input_schema` payloads for compatibility.
      const customTool = tool as {
        type: string;
        name?: string;
        description?: string;
        format?: Record<string, unknown>;
        input_schema?: Record<string, unknown>;
      };
      if (customTool.name) {
        return {
          name: customTool.name,
          description: customTool.description ?? "",
          inputSchema:
            customTool.format ?? customTool.input_schema ?? undefined,
        };
      }
      return null;
    }

    default:
      return null;
  }
};

/**
 * Convert tool choice to VSCode LM tool mode
 */
export const convertToolChoice = (
  toolChoice?: ToolChoice,
): vscode.LanguageModelChatToolMode | undefined => {
  if (!toolChoice || toolChoice === "none") {
    return undefined;
  }
  if (
    toolChoice === "required" ||
    (typeof toolChoice === "object" && toolChoice.type === "function")
  ) {
    return vscode.LanguageModelChatToolMode.Required;
  }
  return vscode.LanguageModelChatToolMode.Auto; // Default for "auto"
};

/**
 * Build output array from accumulated text and tool calls
 * Returns simplified output objects compatible with OpenAI Responses API
 */
export const buildResponseOutput = (
  accumulatedText: string,
  toolCalls: { callId: string; name: string; input: unknown }[],
): OutputItem[] => {
  const output: OutputItem[] = [];

  if (accumulatedText) {
    output.push({
      type: "message",
      id: generateMessageId(),
      role: "assistant",
      content: [
        { type: "output_text", text: accumulatedText, annotations: [] },
      ],
      status: "completed",
    } as ResponseOutputMessage);
  }

  for (const tc of toolCalls) {
    output.push({
      type: "function_call",
      id: generateFunctionCallId(),
      call_id: tc.callId,
      name: tc.name,
      arguments: JSON.stringify(tc.input ?? {}),
      status: "completed",
    } as ResponseFunctionToolCall);
  }

  return output;
};
