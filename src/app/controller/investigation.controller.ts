import type { NextFunction, Request, Response } from "express";
import type { AppDeps } from "../app.ts";
import { getInvestigationService, startInvestigationService } from "../model/investigationModel.ts";
import { errorResponse, successResponse } from "../utils/responseHandler.ts";

// Takes the agent as an argument, so tests can pass one with a fake model.
export const startInvestigation =
  ({ agent, model }: AppDeps) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = startInvestigationService(agent, model, req.body);
      return successResponse(res, 202, "Investigation started", result.data);
    } catch (error) {
      next(error);
    }
  };

export const getInvestigation = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = getInvestigationService(req.params.id as string);

    if (!result.success) {
      return errorResponse(
        res,
        result.status,
        result.code,
        result.message,
        result.details,
      );
    }

    return successResponse(
      res,
      200,
      "Investigation fetched successfully",
      result.data,
    );
  } catch (error) {
    next(error);
  }
};
