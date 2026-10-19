import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";
import { errorResponse } from "../utils/responseHandler.ts";

export const validateBody = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return errorResponse(
          res,
          400,
          "VALIDATION_ERROR",
          "Request body validation failed",
          parsed.error.flatten(),
        );
      }
      req.body = parsed.data;
      next();
    } catch (error) {
      next(error);
    }
  };
};
