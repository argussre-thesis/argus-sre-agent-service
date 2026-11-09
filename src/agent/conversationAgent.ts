import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredTool } from "@langchain/core/tools";
import {
  anthropicPromptCachingMiddleware,
  type BaseMessage,
  createAgent,
  modelCallLimitMiddleware,
  toolErrorMiddleware,
  ToolInvocationError,
} from "langchain";
import { runAgent } from "./agent.ts";
import { connectTools, type McpServer } from "./mcp.ts";
import { unusableSystemsMessage } from "./prompts.ts";

// Answers are free-form, so unlike an investigation there is no citation check.
function createConversationAgent(model: BaseChatModel, systemPrompt: string, tools: StructuredTool[], maxModelCalls: number) {
  return createAgent({
    model,
    systemPrompt,
    tools,
    middleware: [
      toolErrorMiddleware({
        onError: (err) => (ToolInvocationError.isInstance(err) ? `Error BAD_ARGS: ${err.toolError.message}` : undefined),
      }),
      modelCallLimitMiddleware({ runLimit: maxModelCalls, exitBehavior: "error" }),
      anthropicPromptCachingMiddleware({ minMessagesToCache: 1, unsupportedModelBehavior: "ignore" }),
    ],
  }).withConfig({ recursionLimit: 10 * maxModelCalls });
}

const keepNothing = async () => {};

// One turn. With no clusters and no MCP servers the model has no tools.
export async function runConversationTurn(
  model: BaseChatModel,
  systemPrompt: string,
  maxModelCalls: number,
  gatewayUrl: string,
  agentGatewayToken: string,
  messages: BaseMessage[],
  tenantId: string,
  clusters: string[],
  mcpServers: McpServer[],
): Promise<string> {
  const { tools, failed, close } = await connectTools(gatewayUrl, agentGatewayToken, tenantId, clusters, mcpServers);
  try {
    const note = failed.length > 0 ? [unusableSystemsMessage(failed)] : [];
    return await runAgent(createConversationAgent(model, systemPrompt, tools, maxModelCalls), [...note, ...messages], tenantId, clusters, keepNothing);
  } finally {
    await close();
  }
}
