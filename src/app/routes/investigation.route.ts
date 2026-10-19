import express from "express";
import type { AppDeps } from "../app.ts";
import { getInvestigation, startInvestigation } from "../controller/investigation.controller.ts";
import { validateBody } from "../middleware/validateSchema.ts";
import { startInvestigationSchema } from "../schemas/investigation.schema.ts";

export default function investigationRoutes(deps: AppDeps) {
  const router = express.Router();

  router.post("/", validateBody(startInvestigationSchema), startInvestigation(deps));
  router.get("/:id", getInvestigation);

  return router;
}
