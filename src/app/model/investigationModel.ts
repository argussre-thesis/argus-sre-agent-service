import { mapChatMessagesToStoredMessages } from "@langchain/core/messages";
import { AIMessage, type BaseMessage } from "langchain";
import { runWithGateway } from "../../agent/sreAgent.ts";
import { reason } from "../../agent/mcp.ts";
import { incidentMessage } from "../../agent/prompts.ts";
import { log } from "../../log.ts";
import type { AppDeps } from "../app.ts";
import { prisma } from "../lib/prisma.ts";
import type { Prisma } from "../prisma/generated/prisma/client.ts";
import { listInvestigationsQuerySchema, type StartInvestigationBody } from "../schemas/investigation.schema.ts";
import { fail, ok } from "../types/serviceResponse.ts";
import { parseQuery } from "../utils/parseQuery.ts";

// LangChain's usage, the same for every provider. Its input_tokens include the cached ones.
const usage = (m: BaseMessage, model: string) => {
  const u = AIMessage.isInstance(m) ? m.usage_metadata : undefined;
  if (!u) return {};
  const cacheRead = u.input_token_details?.cache_read ?? 0;
  const cacheWrite = u.input_token_details?.cache_creation ?? 0;
  return {
    model,
    uncachedInputTokens: u.input_tokens - cacheRead - cacheWrite,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    outputTokens: u.output_tokens,
  };
};

// LangChain's stored form ({ type, data }), which mapStoredMessagesToChatMessages turns back into messages.
// It is plain JSON; the cast is only because its interfaces lack the index signature Prisma's JSON type wants.
const messageRows = (messages: BaseMessage[], firstSeq: number, model: string) =>
  mapChatMessagesToStoredMessages(messages).map((data, i) => ({
    seq: firstSeq + i,
    data: data as unknown as Prisma.InputJsonObject,
    ...usage(messages[i]!, model),
  }));

const investigationNotFound = () => fail(404, "INVESTIGATION_NOT_FOUND", "Investigation not found");

export const getInvestigationService = async (tenantId: string, id: string) => {
  const investigation = await prisma.investigation.findUnique({ where: { id, tenantId }, omit: { systemPrompt: true } });
  if (!investigation) return investigationNotFound();
  return ok(investigation);
};

export const listInvestigationsService = async (tenantId: string, query: unknown) => {
  const parsed = parseQuery(listInvestigationsQuerySchema, query);
  if (!parsed.success) return parsed;

  const investigations = await prisma.investigation.findMany({
    where: { tenantId, incidentId: parsed.data.incidentId },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    omit: { systemPrompt: true },
  });
  return ok({ investigations });
};

export const getInvestigationMessagesService = async (tenantId: string, id: string) => {
  const investigation = await prisma.investigation.findUnique({
    where: { id, tenantId },
    select: { messages: { orderBy: { seq: "asc" }, select: { seq: true, data: true, createdAt: true } } },
  });
  if (!investigation) return investigationNotFound();
  return ok(investigation);
};

const reportInvestigationEnded = async (
  backendUrl: string,
  backendAgentServiceToken: string,
  tenantId: string,
  incidentId: string,
  investigationId: string,
  status: string,
  report: string | null,
  error: string | null,
) => {
  const res = await fetch(new URL("/internal/v1/investigations/ended", backendUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${backendAgentServiceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ tenantId, incidentId, investigationId, status, report, error }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`the backend answered ${res.status}: ${await res.text()}`);
  const { data } = (await res.json()) as { data: { posted: boolean } };
  return data.posted;
};

// Saves the investigation with its incident, then runs it in the background: each step's messages are saved as they come.
export const startInvestigationService = async (
  { chatModel, model, effort, systemPrompt, maxModelCalls, gatewayUrl, agentGatewayToken, backendUrl, backendAgentServiceToken }: AppDeps,
  tenantId: string,
  { incidentId, cluster, title, alerts, mcpServers }: StartInvestigationBody,
) => {
  const messages = [incidentMessage({ cluster, title, alerts })];
  const created = await prisma.$transaction(async (tx) => {
    // lock until investigation creation is done.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${incidentId}))`;
    const running = await tx.investigation.findFirst({ where: { tenantId, incidentId, status: "running" }, select: { id: true } });
    if (running) return fail(409, "INVESTIGATION_RUNNING", "This incident already has a running investigation", running);
    return ok(
      await tx.investigation.create({
        data: { tenantId, cluster, incidentId, model, effort, systemPrompt, messages: { create: messageRows(messages, 0, model) } },
        select: { id: true },
      }),
    );
  });
  if (!created.success) return created;
  const { id } = created.data;
  log("info", "investigation started", { id, tenantId, cluster, incidentId });

  let seq = messages.length;
  // Do not await, invetigation is running in background
  runWithGateway(chatModel, systemPrompt, maxModelCalls, gatewayUrl, agentGatewayToken, messages, tenantId, [cluster], mcpServers,
    async (added) => {
    await prisma.message.createMany({ data: messageRows(added, seq, model).map((row) => ({ ...row, investigationId: id })) });
    seq += added.length;
    }
  )
    .then(
      (report) => ({ status: "done" as const, report }),
      (err: Error) => {
        log("error", "investigation failed", { id, error: err.stack ?? String(err) });
        return { status: "failed" as const, error: err.message };
      },
    )
    .then((end) => prisma.investigation.update({ where: { id }, data: { ...end, finishedAt: new Date() } }))
    .then(({ status, report, error }) => {
      log("info", "investigation finished", { id, status, steps: seq - 1 });
      // A failed call only logged
      reportInvestigationEnded(backendUrl, backendAgentServiceToken, tenantId, incidentId, id, status, report, error)
        .then((posted) => log("info", "backend told the investigation ended", { id, posted }))
        .catch((err: Error) => log("error", "cannot tell the backend the investigation ended", { id, error: reason(err) }));
    })
    // The row then stays `running` until the next startup marks it failed.
    .catch((err: Error) => log("error", "cannot save the investigation's end", { id, error: err.stack ?? String(err) }));
  return ok({ id });
};

// At startup, marks investigations that were running when service stopped as failed.
export const failInterruptedInvestigationsService = async () => {
  const { count } = await prisma.investigation.updateMany({
    where: { status: "running" },
    data: { status: "failed", error: "the service stopped before the run finished", finishedAt: new Date() },
  });
  return count;
};
