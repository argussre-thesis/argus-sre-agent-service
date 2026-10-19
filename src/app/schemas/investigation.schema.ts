import * as z from "zod";

export const startInvestigationSchema = z.strictObject({
  tenantId: z.string().min(1),
  cluster: z.string().min(1),
  incidentId: z.string().min(1).optional(),
  alert: z.record(z.string(), z.unknown()),
});
export type StartInvestigationBody = z.infer<typeof startInvestigationSchema>;
