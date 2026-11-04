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
import { connectGateway } from "./mcp.ts";

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
      anthropicPromptCachingMiddleware({ unsupportedModelBehavior: "ignore" }),
    ],
  }).withConfig({ recursionLimit: 10 * maxModelCalls });
}

// Nothing is kept from a turn's steps; runAgent logs their tokens.
const keepNothing = async () => {};

// One turn. With no clusters there is nothing to connect to, so the model has no tools.
export async function runConversationTurn(
  model: BaseChatModel,
  systemPrompt: string,
  maxModelCalls: number,
  gatewayUrl: string,
  agentGatewayToken: string,
  messages: BaseMessage[],
  tenantId: string,
  clusters: string[],
): Promise<string> {
  if (clusters.length === 0) {
    return runAgent(createConversationAgent(model, systemPrompt, [], maxModelCalls), messages, tenantId, clusters, keepNothing);
  }
  const gateway = await connectGateway(gatewayUrl, agentGatewayToken, tenantId, clusters);
  try {
    return await runAgent(createConversationAgent(model, systemPrompt, gateway.tools, maxModelCalls), messages, tenantId, clusters, keepNothing);
  } finally {
    await gateway.close();
  }
}
