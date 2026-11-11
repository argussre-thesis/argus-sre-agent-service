import * as z from "zod";
import { LEVELS } from "../../config.ts";

const alertSchema = z.strictObject({
  status: z.enum(["FIRING", "RESOLVED"]),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).nullish(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
});

export const incidentSchema = z.strictObject({
  incidentId: z.string().min(1),
  cluster: z.string().min(1),
  title: z.string().min(1),
  alerts: z.array(alertSchema).min(1),
});

const mcpServerFields = {
  name: z.string().regex(/^[a-z0-9-]{1,20}$/),
  url: z.string().min(1),
};

export const mcpServersSchema = z
  .array(
    z.union([
      z.strictObject({ ...mcpServerFields, token: z.string().min(1) }),
      z.strictObject({ ...mcpServerFields, headers: z.record(z.string().min(1), z.string().min(1)) }),
    ]),
  )
  .default([]);

export const levelSchema = z.enum(LEVELS).default("low");

export const webSearchSchema = z.boolean().default(false);

export const maxModelCallsSchema = z.number().int().positive().optional();

export const startInvestigationSchema = incidentSchema.extend({ mcpServers: mcpServersSchema, level: levelSchema, webSearch: webSearchSchema, maxModelCalls: maxModelCallsSchema });
export type StartInvestigationBody = z.infer<typeof startInvestigationSchema>;

export const listInvestigationsQuerySchema = z.object({
  incidentId: z.string().min(1),
});
