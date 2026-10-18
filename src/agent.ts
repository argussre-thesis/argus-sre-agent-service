import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  anthropicPromptCachingMiddleware,
  type BaseMessage,
  createAgent,
  modelCallLimitMiddleware,
  toolErrorMiddleware,
  ToolInvocationError,
} from "langchain";
import * as z from "zod";
import { log } from "./log.ts";
import type { OpsContext } from "./ops.ts";
import type { createTools } from "./tools.ts";

export function createSreAgent(model: BaseChatModel, systemPrompt: string, tools: ReturnType<typeof createTools>, maxModelCalls: number) {
  return createAgent({
    model,
    systemPrompt,
    tools,
    contextSchema: z.object({ tenantId: z.string(), cluster: z.string() }),
    middleware: [
      // LangChain's text for bad args carries a JS stack trace with our file paths; the model needs only Zod's message.
      toolErrorMiddleware({
        onError: (err) => (ToolInvocationError.isInstance(err) ? `Error BAD_ARGS: ${err.toolError.message}` : undefined),
      }),
      // "error": at the limit the run fails, instead of ending without a report and looking finished.
      modelCallLimitMiddleware({ runLimit: maxModelCalls, exitBehavior: "error" }),
      // "ignore": other providers are skipped without a warning (OpenAI caches by itself).
      anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
    ],
    // LangGraph stops after 25 graph steps, and each model call is several (middleware, model, tools): let the call limit decide.
  }).withConfig({ recursionLimit: 10 * maxModelCalls });
}

export type SreAgent = ReturnType<typeof createSreAgent>;

// A normal end: Anthropic's stop_reason, OpenAI's finish_reason (Chat Completions) or status (Responses API).
const FINISHED = ["end_turn", "stop", "completed"];

function stopReason(m: AIMessage): string | undefined {
  const meta = m.response_metadata as { stop_reason?: string; finish_reason?: string; status?: string };
  return meta.stop_reason ?? meta.finish_reason ?? meta.status;
}

// Runs the agent until it answers and returns the report. `onStep` gets each step's new messages, in order.
// Throws when the run ends any other way: call limit, max_tokens, refusal, API error.
export async function runAgent(
  agent: SreAgent,
  messages: BaseMessage[],
  context: OpsContext,
  onStep: (added: BaseMessage[]) => Promise<void>,
): Promise<string> {
  let all = messages;
  for await (const state of await agent.stream({ messages }, { streamMode: "values", context })) {
    if (state.messages.length === all.length) continue;
    const added = state.messages.slice(all.length);
    all = state.messages;
    for (const m of added) if (AIMessage.isInstance(m)) logStep(m, context);
    await onStep(added);
  }
  const last = all.at(-1);
  const reason = AIMessage.isInstance(last) ? stopReason(last) : undefined;
  if (!AIMessage.isInstance(last) || (reason !== undefined && !FINISHED.includes(reason))) {
    throw new Error(`run ended without a report (stop reason: ${reason ?? "none"})`);
  }
  return last.text;
}

function logStep(m: AIMessage, context: OpsContext): void {
  const u = m.usage_metadata;
  log("info", "model step", {
    ...context,
    stopReason: stopReason(m),
    toolCalls: m.tool_calls?.map(({ name, args }) => ({ name, args })),
    tokens: u && {
      input: u.input_tokens,
      cacheRead: u.input_token_details?.cache_read ?? 0,
      cacheWrite: u.input_token_details?.cache_creation ?? 0,
      output: u.output_tokens,
    },
  });
}
