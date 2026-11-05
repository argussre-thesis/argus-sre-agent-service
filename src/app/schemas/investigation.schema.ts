import * as z from "zod";

// An alert's fields as the backend stores them.
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

export const mcpServersSchema = z
  .array(
    z.strictObject({
      name: z.string().regex(/^[a-z0-9-]{1,20}$/),
      url: z.string().min(1),
      token: z.string().min(1),
    }),
  )
  .default([]);

export const startInvestigationSchema = incidentSchema.extend({ mcpServers: mcpServersSchema });
export type StartInvestigationBody = z.infer<typeof startInvestigationSchema>;

export const listInvestigationsQuerySchema = z.object({
  incidentId: z.string().min(1),
});
