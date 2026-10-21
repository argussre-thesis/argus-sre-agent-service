import * as z from "zod";

// An alert's fields as the backend stores them.
const alertSchema = z.strictObject({
  status: z.enum(["FIRING", "RESOLVED"]),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).nullish(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
});

// The incident as the backend has it
export const startInvestigationSchema = z.strictObject({
  incidentId: z.string().min(1),
  cluster: z.string().min(1),
  title: z.string().min(1),
  alerts: z.array(alertSchema).min(1),
});
export type StartInvestigationBody = z.infer<typeof startInvestigationSchema>;

export const listInvestigationsQuerySchema = z.object({
  incidentId: z.string().min(1),
});
