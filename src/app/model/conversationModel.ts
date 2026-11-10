import { runConversationTurn } from "../../agent/conversationAgent.ts";
import { reason } from "../../agent/mcp.ts";
import { conversationMessage } from "../../agent/prompts.ts";
import { log } from "../../log.ts";
import type { AppDeps } from "../app.ts";
import { prisma } from "../lib/prisma.ts";
import type { ConversationMessageBody } from "../schemas/conversation.schema.ts";
import { ok } from "../types/serviceResponse.ts";

const reportConversationEnded = async (
  backendUrl: string,
  backendAgentServiceToken: string,
  tenantId: string,
  externalId: string,
  status: string,
  reply: string | null,
  error: string | null,
) => {
  const res = await fetch(new URL("/internal/v1/conversations/ended", backendUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${backendAgentServiceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ tenantId, externalId, status, reply, error }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`the backend answered ${res.status}: ${await res.text()}`);
  const { data } = (await res.json()) as { data: { posted: boolean } };
  return data.posted;
};

// The newest report, even if a later run failed or is still running. A running rerun's report arrives on a later mention.
const newestRun = async (tenantId: string, incidentId: string) => {
  const runs = await prisma.investigation.findMany({
    where: { tenantId, incidentId, status: { not: "running" } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { status: true, report: true, error: true },
  });
  return runs.find((r) => r.status === "done") ?? runs[0];
};

// Runs one turn in the background. Nothing is stored: the reply goes to the backend when the turn ends.
export const sendConversationMessageService = async (
  { models, conversationPrompt, maxModelCalls, gatewayUrl, agentGatewayToken, backendUrl, backendAgentServiceToken }: AppDeps,
  tenantId: string,
  { externalId, text, clusters, incident, mcpServers, level, webSearch }: ConversationMessageBody,
) => {
  const { chatModel, model, effort, webSearch: webSearchTool } = models[level];
  const run = incident && (await newestRun(tenantId, incident.incidentId));
  const messages = [conversationMessage(text, clusters, incident, run)];

  log("info", "conversation turn started", { tenantId, externalId, level, model, effort, webSearch });

  runConversationTurn(chatModel, conversationPrompt, maxModelCalls, gatewayUrl, agentGatewayToken, messages, tenantId, clusters, mcpServers, webSearch ? webSearchTool : null)
    .then(
      (reply) => ({ status: "done" as const, reply, error: null }),
      (err: Error) => {
        log("error", "conversation turn failed", { tenantId, externalId, error: err.stack ?? String(err) });
        return { status: "failed" as const, reply: null, error: err.message };
      },
    )
    .then(({ status, reply, error }) => {
      log("info", "conversation turn finished", { tenantId, externalId, status });
      return reportConversationEnded(backendUrl, backendAgentServiceToken, tenantId, externalId, status, reply, error);
    })
    .then((posted) => log("info", "backend told the conversation turn ended", { tenantId, externalId, posted }))
    // A failed call is only logged, so the reply is lost.
    .catch((err: Error) => log("error", "cannot tell the backend the conversation turn ended", { tenantId, externalId, error: reason(err) }));
  return ok(null);
};
