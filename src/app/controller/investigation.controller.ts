import type { NextFunction, Request, Response } from "express";
import type { AppDeps } from "../app.ts";
import {
  getInvestigationMessagesService,
  getInvestigationService,
  listInvestigationsService,
  startInvestigationService,
} from "../model/investigationModel.ts";
import { errorResponse, successResponse } from "../utils/responseHandler.ts";

// Takes the agent as an argument, so tests can pass one with a fake model.
export const startInvestigation =
  (deps: AppDeps) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await startInvestigationService(
        deps,
        req.params.tenantId as string,
        req.body,
      );

      if (!result.success) {
        return errorResponse(
          res,
          result.status,
          result.code,
          result.message,
          result.details,
        );
      }

      return successResponse(res, 202, "Investigation started", result.data);
    } catch (error) {
      next(error);
    }
  };

export const listInvestigations = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await listInvestigationsService(
      req.params.tenantId as string,
      req.query,
    );

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
      "Investigations fetched successfully",
      result.data,
    );
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
    const result = await getInvestigationService(
      req.params.tenantId as string,
      req.params.id as string,
    );

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

export const getInvestigationMessages = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await getInvestigationMessagesService(
      req.params.tenantId as string,
      req.params.id as string,
    );

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
      "Messages fetched successfully",
      result.data,
    );
  } catch (error) {
    next(error);
  }
};
