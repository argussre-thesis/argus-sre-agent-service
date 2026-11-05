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
import { finished, runAgent } from "./agent.ts";
import { citationProblems } from "./citations.ts";
import { log } from "../log.ts";
import { connectGateway, type McpServer } from "./mcp.ts";

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
  onStep: (added: BaseMessage[]) => Promise<void>,
): Promise<string> {
  const gateway = await connectGateway(gatewayUrl, agentGatewayToken, tenantId, clusters);
  try {
    return await runAgent(createSreAgent(model, systemPrompt, gateway.tools, maxModelCalls), messages, tenantId, clusters, onStep);
  } finally {
    await gateway.close();
  }
}
