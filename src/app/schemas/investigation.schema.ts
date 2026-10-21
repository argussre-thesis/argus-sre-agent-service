import * as z from "zod";

// The incident as the backend has it
export const startInvestigationSchema = z.strictObject({
  incidentId: z.string().min(1),
  cluster: z.string().min(1),
  title: z.string().min(1),
  alerts: z.array(z.record(z.string(), z.unknown())).min(1),
});
export type StartInvestigationBody = z.infer<typeof startInvestigationSchema>;

export const listInvestigationsQuerySchema = z.object({
  incidentId: z.string().min(1),
});
