import * as z from "zod";
import { startInvestigationSchema } from "./investigation.schema.ts";

export const conversationMessageSchema = z.strictObject({
  // Where the reply goes, e.g. Slack's <channel>:<thread_ts>. An opaque string here, handed back to the backend as it came.
  externalId: z.string().min(1),
  // The thread's latest messages, as the backend wrote them out.
  text: z.string().min(1),
  // The org's clusters. None: no gateway connection and no tools.
  clusters: z.array(z.string().min(1)).default([]),
  // Only in an incident's thread.
  incident: startInvestigationSchema.optional(),
});
export type ConversationMessageBody = z.infer<typeof conversationMessageSchema>;
