import express, { type ErrorRequestHandler } from "express";
import * as z from "zod";
import type { SreAgent } from "./agent.ts";
import { getInvestigation, startInvestigation } from "./investigations.ts";
import { log } from "./log.ts";

// strictObject: a mistyped field is a 400, not silently dropped. The alert's shape is fixed with the backend in step 7.
const StartBody = z.strictObject({
  tenantId: z.string().min(1),
  cluster: z.string().min(1),
  incidentId: z.string().min(1).optional(),
  alert: z.record(z.string(), z.unknown()),
});

export function createApp({ agent, model }: { agent: SreAgent; model: string }) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/investigations", (req, res) => {
    const body = StartBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: z.prettifyError(body.error) });
      return;
    }
    res.status(202).json({ id: startInvestigation(agent, model, body.data).id });
  });

  app.get("/investigations/:id", (req, res) => {
    const inv = getInvestigation(req.params.id);
    if (!inv) {
      res.status(404).json({ error: "investigation not found" });
      return;
    }
    const { messages, ...rest } = inv;
    res.json(rest);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  app.use(((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (!err.expose) log("error", "request failed", { error: err.stack ?? String(err) });
    res.status(err.status ?? 500).json({ error: err.expose ? err.message : "internal error" });
  }) satisfies ErrorRequestHandler);

  return app;
}
