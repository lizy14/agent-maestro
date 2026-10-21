import type { MiddlewareHandler } from "hono";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type * as vscode from "vscode";

import { extractCopilotUsagePayload } from "../server/utils/copilotUsage";
import { UsageRecord, boundedLabel, count } from "./model";

interface RequestContext {
  requestId: string;
  endpoint: string;
  client: string;
  sessionId?: string;
  sessionName?: string;
  signal: AbortSignal;
}
const requestContext = new AsyncLocalStorage<RequestContext>();
let sink: ((record: UsageRecord) => void) | undefined;
let enabled: () => boolean = () => false;

export function configureUsageTracking(
  record: (row: UsageRecord) => void,
  isEnabled: () => boolean,
): void {
  sink = record;
  enabled = isEnabled;
}

export function usageMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const endpoint = c.req.path;
    if (
      c.req.method !== "POST" ||
      !/(\/v1\/(responses|chat\/completions|messages)|:(streamGenerateContent|generateContent))$/.test(
        endpoint,
      )
    ) {
      return next();
    }
    const agent = c.req.header("user-agent") ?? "";
    const client = /codex/i.test(agent)
      ? "Codex"
      : /claude/i.test(agent)
        ? "Claude"
        : /copilot/i.test(agent)
          ? "Copilot"
          : /gemini/i.test(agent)
            ? "Gemini"
            : "Other";
    const sessionId = [
      "x-agent-maestro-session-id",
      "session_id",
      "session-id",
      "thread-id",
      "x-session-id",
    ]
      .map((key) => boundedLabel(c.req.header(key)))
      .find(Boolean);
    await requestContext.run(
      {
        requestId: randomUUID(),
        endpoint,
        client,
        sessionId,
        sessionName: boundedLabel(c.req.header("x-agent-maestro-session-name")),
        signal: c.req.raw.signal,
      },
      next,
    );
  };
}

// Wrap the provider call rather than the HTTP response: streamed usage may be
// omitted by clients, and web-search loops can make several billable calls.
export async function sendTrackedRequest(
  client: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  options?: vscode.LanguageModelChatRequestOptions,
  token?: vscode.CancellationToken,
  clock: () => number = () => performance.now(),
): Promise<vscode.LanguageModelChatResponse> {
  const context = requestContext.getStore();
  if (!context || !sink || !enabled()) {
    return client.sendRequest(messages, options, token);
  }
  const record: UsageRecord = {
    version: 1,
    id: randomUUID(),
    requestId: context.requestId,
    startedAt: Date.now(),
    durationMs: 0,
    endpoint: context.endpoint,
    client: context.client,
    model: boundedLabel(client.id) ?? "unknown",
    sessionId:
      context.sessionId ?? boundedLabel(options?.modelOptions?._conversationId),
    sessionName: context.sessionName,
    outcome: "failed",
  };
  const started = clock();
  let finished = false;
  let cancellation: vscode.Disposable | undefined;
  const finish = (outcome: UsageRecord["outcome"]) => {
    if (finished) {
      return;
    }
    finished = true;
    record.outcome = outcome;
    record.durationMs = Math.max(0, Math.round(clock() - started));
    cancellation?.dispose();
    context.signal.removeEventListener("abort", abort);
    // Metrics must never alter the outcome of a model request.
    try {
      if (enabled()) {
        sink?.({ ...record });
      }
    } catch {
      /* Collector failure is isolated. */
    }
  };
  const abort = () => finish("cancelled");
  cancellation = token?.onCancellationRequested(abort);
  context.signal.addEventListener("abort", abort, { once: true });
  if (token?.isCancellationRequested || context.signal.aborted) {
    abort();
  }
  try {
    const response = await client.sendRequest(messages, options, token);
    const stream = (async function* () {
      let completed = false;
      try {
        for await (const chunk of response.stream) {
          if (
            chunk &&
            typeof chunk === "object" &&
            "mimeType" in chunk &&
            "data" in chunk
          ) {
            const usage =
              typeof chunk.mimeType === "string" &&
              chunk.data instanceof Uint8Array
                ? extractCopilotUsagePayload({
                    mimeType: chunk.mimeType,
                    data: chunk.data,
                  })
                : undefined;
            if (usage) {
              record.inputTokens = count(usage.prompt_tokens);
              record.outputTokens = count(usage.completion_tokens);
              record.cachedTokens = count(
                usage.prompt_tokens_details?.cached_tokens,
              );
              record.cacheWriteTokens = count(
                usage.prompt_tokens_details?.cache_creation_input_tokens,
              );
              record.reasoningTokens = count(
                usage.completion_tokens_details?.reasoning_tokens,
              );
            }
          } else if (
            chunk &&
            typeof chunk === "object" &&
            (("value" in chunk &&
              typeof chunk.value === "string" &&
              chunk.value.length > 0) ||
              ("callId" in chunk && typeof chunk.callId === "string"))
          ) {
            const elapsed = Math.max(0, Math.round(clock() - started));
            record.firstTokenMs ??= elapsed;
            record.lastTokenMs = elapsed;
            record.contentChunks = (record.contentChunks ?? 0) + 1;
          }
          yield chunk;
        }
        completed = true;
        finish("completed");
      } catch (error) {
        finish(token?.isCancellationRequested ? "cancelled" : "failed");
        throw error;
      } finally {
        if (!completed) {
          finish("cancelled");
        }
      }
    })();
    return { ...response, stream };
  } catch (error) {
    finish(token?.isCancellationRequested ? "cancelled" : "failed");
    throw error;
  }
}
