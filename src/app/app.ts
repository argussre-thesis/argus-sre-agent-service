import express from "express";
import type { SreAgent } from "../agent/agent.ts";
import errorHandling from "./middleware/error/errorHandler.ts";
import { requireInternalToken } from "./middleware/internalAuth.ts";
import investigationRoutes from "./routes/investigation.route.ts";
import { errorResponse } from "./utils/responseHandler.ts";

// The model name and system prompt are the agent's, stored with each investigation.
export type AppDeps = { agent: SreAgent; model: string; systemPrompt: string; internalApiToken: string };

export function createApp(deps: AppDeps) {
  const app = express();
  app.use(requireInternalToken(deps.internalApiToken));
  app.use(express.json({ limit: "1mb" }));

  app.use("/tenants/:tenantId/investigations", investigationRoutes(deps));

  app.use((_req, res) => {
    errorResponse(res, 404, "ROUTE_NOT_FOUND", "Route not found");
  });
  app.use(errorHandling);

  return app;
}
