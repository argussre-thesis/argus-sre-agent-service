import { mapChatMessagesToStoredMessages } from "@langchain/core/messages";
import type { BaseMessage } from "langchain";
import { runAgent } from "../../agent/agent.ts";
import { alertMessage } from "../../agent/prompts.ts";
import { log } from "../../log.ts";
import type { AppDeps } from "../app.ts";
import { prisma } from "../lib/prisma.ts";
import type { Prisma } from "../prisma/generated/prisma/client.ts";
import type { StartInvestigationBody } from "../schemas/investigation.schema.ts";
import { fail, ok } from "../types/serviceResponse.ts";

// LangChain's stored form ({ type, data }), which mapStoredMessagesToChatMessages turns back into messages.
// It is plain JSON; the cast is only because its interfaces lack the index signature Prisma's JSON type wants.
const messageRows = (messages: BaseMessage[], firstSeq: number) =>
  mapChatMessagesToStoredMessages(messages).map((data, i) => ({
    seq: firstSeq + i,
    data: data as unknown as Prisma.InputJsonObject,
  }));

export const getInvestigationService = async (id: string) => {
  const investigation = await prisma.investigation.findUnique({ where: { id }, omit: { systemPrompt: true } });
  if (!investigation) {
    return fail(404, "INVESTIGATION_NOT_FOUND", "Investigation not found");
  }
  return ok(investigation);
};

// Saves the investigation with its alert, then runs it in the background: each step's messages are saved as they come.
export const startInvestigationService = async (
  { agent, model, systemPrompt }: AppDeps,
  { tenantId, cluster, incidentId, alert }: StartInvestigationBody,
) => {
  const messages = [alertMessage(cluster, alert)];
  const { id } = await prisma.investigation.create({
    data: { tenantId, cluster, incidentId, model, systemPrompt, messages: { create: messageRows(messages, 0) } },
    select: { id: true },
  });
  log("info", "investigation started", { id, tenantId, cluster, incidentId });

  let seq = messages.length;
  // Nothing awaits this promise, so it must never reject: Node 24 exits on an unhandled rejection.
  runAgent(agent, messages, { tenantId, cluster }, async (added) => {
    await prisma.message.createMany({ data: messageRows(added, seq).map((row) => ({ ...row, investigationId: id })) });
    seq += added.length;
  })
    .then(
      (report) => ({ status: "done" as const, report }),
      (err: Error) => {
        log("error", "investigation failed", { id, error: err.stack ?? String(err) });
        return { status: "failed" as const, error: err.message };
      },
    )
    .then((end) => prisma.investigation.update({ where: { id }, data: { ...end, finishedAt: new Date() } }))
    .then(({ status }) => log("info", "investigation finished", { id, status, steps: seq - 1 }))
    // The row then stays `running` (5b.5 marks those failed at startup).
    .catch((err: Error) => log("error", "cannot save the investigation's end", { id, error: err.stack ?? String(err) }));
  return ok({ id });
};
