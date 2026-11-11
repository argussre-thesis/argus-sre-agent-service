import express from "express";
import type { AppDeps } from "../app.ts";
import {
  getInvestigation,
  getInvestigationMessages,
  listInvestigations,
  startInvestigation,
} from "../controller/investigation.controller.ts";
import { validateBody } from "../middleware/validateSchema.ts";
import { startInvestigationSchema } from "../schemas/investigation.schema.ts";

export default function investigationRoutes(deps: AppDeps) {
  const router = express.Router({ mergeParams: true });

  router.post("/", validateBody(startInvestigationSchema), startInvestigation(deps));
  router.get("/", listInvestigations);
  router.get("/:id", getInvestigation);
  router.get("/:id/messages", getInvestigationMessages);

  return router;
}
