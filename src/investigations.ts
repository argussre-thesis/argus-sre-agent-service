import { randomUUID } from "node:crypto";
import type { BaseMessage } from "langchain";
import { runAgent, type SreAgent } from "./agent.ts";
import { log } from "./log.ts";
import { alertMessage } from "./prompts.ts";

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

export type StartInput = { tenantId: string; cluster: string; incidentId?: string; alert: Record<string, unknown> };

// shortcut: in memory, so a restart forgets every run; Postgres in 5b.
const investigations = new Map<string, Investigation>();

export function getInvestigation(id: string): Investigation | undefined {
  return investigations.get(id);
}

// Starts the run in the background and returns at once; the run updates the investigation as it goes.
export function startInvestigation(agent: SreAgent, model: string, { tenantId, cluster, incidentId, alert }: StartInput): Investigation {
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
  return inv;
}
