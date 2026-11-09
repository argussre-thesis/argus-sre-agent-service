import * as z from "zod";
import { incidentSchema, levelSchema, mcpServersSchema } from "./investigation.schema.ts";

export const conversationMessageSchema = z.strictObject({
  // Where the reply goes, e.g. Slack's <channel>:<thread_ts>. An opaque string here, handed back to the backend as it came.
  externalId: z.string().min(1),
  text: z.string().min(1),
  // The org's clusters. None: no gateway connection and no tools.
  clusters: z.array(z.string().min(1)).default([]),
  incident: incidentSchema.optional(),
  mcpServers: mcpServersSchema,
  level: levelSchema,
});
export type ConversationMessageBody = z.infer<typeof conversationMessageSchema>;
