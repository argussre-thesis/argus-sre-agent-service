import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ServerTool, StructuredTool } from "@langchain/core/tools";
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
import { finished, runAgent } from "./agent.ts";
import { citationProblems } from "./citations.ts";
import { log } from "../log.ts";
import { connectTools, type McpServer } from "./mcp.ts";
import { unusableSystemsMessage } from "./prompts.ts";

export function createSreAgent(model: BaseChatModel, systemPrompt: string, tools: (StructuredTool | ServerTool)[], maxModelCalls: number) {
  console.log("TOOLS", tools)
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
      anthropicPromptCachingMiddleware({ minMessagesToCache: 1, unsupportedModelBehavior: "ignore" }),
    ],
  }).withConfig({ recursionLimit: 10 * maxModelCalls });
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

export async function runWithGateway(
  model: BaseChatModel,
  systemPrompt: string,
  maxModelCalls: number,
  gatewayUrl: string,
  agentGatewayToken: string,
  messages: BaseMessage[],
  tenantId: string,
  clusters: string[],
  mcpServers: McpServer[],
  webSearch: ServerTool | null,
  onStep: (added: BaseMessage[]) => Promise<void>,
): Promise<string> {
  const { tools, failed, close } = await connectTools(gatewayUrl, agentGatewayToken, tenantId, clusters, mcpServers);
  try {
    if (tools.length === 0 && !webSearch) throw new Error("the investigation can't start without tools");
    const note = failed.length > 0 ? [unusableSystemsMessage(failed, false)] : [];
    if (note.length > 0) await onStep(note);
    return await runAgent(createSreAgent(model, systemPrompt, webSearch ? [...tools, webSearch] : tools, maxModelCalls), [...messages, ...note], tenantId, clusters, onStep);
  } finally {
    await close();
  }
}
