import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredTool } from "@langchain/core/tools";
import {
  AIMessage,
  anthropicPromptCachingMiddleware,
  type BaseMessage,
  createAgent,
  createMiddleware,
  HumanMessage,
  modelCallLimitMiddleware,
  toolErrorMiddleware,
  ToolInvocationError,
} from "langchain";
import { citationProblems } from "./citations.ts";
import { log } from "../log.ts";
import { connectGateway } from "./mcp.ts";

export function createSreAgent(model: BaseChatModel, systemPrompt: string, tools: StructuredTool[], maxModelCalls: number) {
  return createAgent({
    model,
    systemPrompt,
    tools,
    middleware: [
      toolErrorMiddleware({
        onError: (err) => (ToolInvocationError.isInstance(err) ? `Error BAD_ARGS: ${err.toolError.message}` : undefined),
      }),
      citationCheck,
      modelCallLimitMiddleware({ runLimit: maxModelCalls, exitBehavior: "error" }),
      anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
    ],
  }).withConfig({ recursionLimit: 10 * maxModelCalls });
}

export type SreAgent = ReturnType<typeof createSreAgent>;

const FINISHED = ["end_turn", "stop", "completed"];
function stopReason(m: AIMessage): string | undefined {
  const meta = m.response_metadata as { stop_reason?: string; finish_reason?: string; status?: string };
  return meta.stop_reason ?? meta.finish_reason ?? meta.status;
}

function finished(m: AIMessage): boolean {
  const reason = stopReason(m);
  return reason === undefined || FINISHED.includes(reason);
}

const FIX_REQUEST = "Your report's citations don't match your tool calls:";
const citationCheck = createMiddleware({
  name: "CitationCheck",
  afterModel: {
    canJumpTo: ["model"],
    hook: (state) => {
      const last = state.messages.at(-1);
      if (!AIMessage.isInstance(last) || last.tool_calls?.length || !finished(last)) return;
      const problems = citationProblems(last.text, state.messages);
      if (problems.length === 0) return;
      if (state.messages.some((m) => HumanMessage.isInstance(m) && m.text.startsWith(FIX_REQUEST))) {
        throw new Error(`the report's citations still don't match its tool calls: ${problems.join("; ")}`);
      }
      log("warn", "report citations don't match, asking for a fix", { problems });
      const list = problems.map((p) => `- ${p}`).join("\n");
      const fix = `${FIX_REQUEST}\n${list}\nWrite the whole report again, ending each Evidence bullet with a tool call you made: its name and its arguments as JSON, in backticks. Make the call first if you need the evidence.`;
      return { messages: [new HumanMessage(fix)], jumpTo: "model" };
    },
  },
});

// Runs the agent until it answers and returns the report. `onStep` gets each step's new messages, in order.
// Throws when the run ends any other way: call limit, max_tokens, refusal, API error.
export async function runAgent(
  agent: SreAgent,
  messages: BaseMessage[],
  tenantId: string,
  onStep: (added: BaseMessage[]) => Promise<void>,
): Promise<string> {
  let all = messages;
  for await (const state of await agent.stream({ messages }, { streamMode: "values" })) {
    if (state.messages.length === all.length) continue;
    const added = state.messages.slice(all.length);
    all = state.messages;
    for (const m of added) if (AIMessage.isInstance(m)) logStep(m, tenantId);
    await onStep(added);
  }
  const last = all.at(-1);
  if (!AIMessage.isInstance(last) || !finished(last)) {
    throw new Error(`run ended without a report (stop reason: ${(AIMessage.isInstance(last) && stopReason(last)) || "none"})`);
  }
  return last.text;
}

export async function runWithGateway(
  model: BaseChatModel,
  systemPrompt: string,
  maxModelCalls: number,
  gatewayUrl: string,
  agentGatewayToken: string,
  messages: BaseMessage[],
  tenantId: string,
  clusters: string[],
  onStep: (added: BaseMessage[]) => Promise<void>,
): Promise<string> {
  const gateway = await connectGateway(gatewayUrl, agentGatewayToken, tenantId, clusters);
  try {
    return await runAgent(createSreAgent(model, systemPrompt, gateway.tools, maxModelCalls), messages, tenantId, onStep);
  } finally {
    await gateway.close();
  }
}

// Each tool call's cluster is in its args.
function logStep(m: AIMessage, tenantId: string): void {
  const u = m.usage_metadata;
  log("info", "model step", {
    tenantId,
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
