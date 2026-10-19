import { randomUUID } from "node:crypto";
import type { BaseMessage } from "langchain";
import { runAgent, type SreAgent } from "../../agent/agent.ts";
import { log } from "../../log.ts";
import { alertMessage } from "../../agent/prompts.ts";
import type { StartInvestigationBody } from "../schemas/investigation.schema.ts";
import { fail, ok } from "../types/serviceResponse.ts";

export type Investigation = {
  id: string;
  tenantId: string;
  cluster: string;
  incidentId?: string;
  model: string;
  status: "running" | "done" | "failed";
  messages: BaseMessage[];
  report?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
};

// shortcut: in memory, so a restart forgets every run; Postgres in 5b.
export const investigations = new Map<string, Investigation>();

export const getInvestigationService = (id: string) => {
  const inv = investigations.get(id);
  if (!inv) return fail(404, "INVESTIGATION_NOT_FOUND", "Investigation not found");
  const { messages, ...rest } = inv;
  return ok(rest);
};

// Starts the run in the background and returns at once; the run updates the investigation as it goes.
export const startInvestigationService = (
  agent: SreAgent,
  model: string,
  { tenantId, cluster, incidentId, alert }: StartInvestigationBody,
) => {
  const inv: Investigation = {
    id: randomUUID(),
    tenantId,
    cluster,
    incidentId,
    model,
    status: "running",
    messages: [alertMessage(cluster, alert)],
    startedAt: new Date().toISOString(),
  };
  investigations.set(inv.id, inv);
  log("info", "investigation started", { id: inv.id, tenantId, cluster, incidentId });

  // Nothing awaits this promise, so it must never reject: Node 24 exits on an unhandled rejection.
  runAgent(agent, [...inv.messages], { tenantId, cluster }, async (added) => {
    inv.messages.push(...added);
  })
    .then((report) => Object.assign(inv, { status: "done", report }))
    .catch((err: Error) => {
      Object.assign(inv, { status: "failed", error: err.message });
      log("error", "investigation failed", { id: inv.id, error: err.stack ?? String(err) });
    })
    .finally(() => {
      inv.finishedAt = new Date().toISOString();
      log("info", "investigation finished", { id: inv.id, status: inv.status, steps: inv.messages.length - 1 });
    });
  return ok({ id: inv.id });
};
