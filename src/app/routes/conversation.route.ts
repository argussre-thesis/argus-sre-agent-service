import express from "express";
import type { AppDeps } from "../app.ts";
import { sendConversationMessage } from "../controller/conversation.controller.ts";
import { validateBody } from "../middleware/validateSchema.ts";
import { conversationMessageSchema } from "../schemas/conversation.schema.ts";

export default function conversationRoutes(deps: AppDeps) {
  const router = express.Router({ mergeParams: true });

  router.post("/messages", validateBody(conversationMessageSchema), sendConversationMessage(deps));

  return router;
}
