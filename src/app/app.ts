import express from "express";
import type { Level } from "../config.ts";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import errorHandling from "./middleware/error/errorHandler.ts";
import { requireInternalToken } from "./middleware/internalAuth.ts";
import conversationRoutes from "./routes/conversation.route.ts";
import investigationRoutes from "./routes/investigation.route.ts";
import { errorResponse } from "./utils/responseHandler.ts";

export type AppDeps = {
  models: Record<Level, { chatModel: BaseChatModel; model: string; effort: string | null }>;
  systemPrompt: string;
  conversationPrompt: string;
  maxModelCalls: number;
  gatewayUrl: string;
  agentGatewayToken: string;
  backendUrl: string;
  backendAgentServiceToken: string;
};

export function createApp(deps: AppDeps) {
  const app = express();
  app.use(requireInternalToken(deps.backendAgentServiceToken));
  app.use(express.json({ limit: "1mb" }));

  app.use("/api/v1/tenants/:tenantId/investigations", investigationRoutes(deps));
  app.use("/api/v1/tenants/:tenantId/conversations", conversationRoutes(deps));

  app.use((_req, res) => {
    errorResponse(res, 404, "ROUTE_NOT_FOUND", "Route not found");
  });
  app.use(errorHandling);

  return app;
}
