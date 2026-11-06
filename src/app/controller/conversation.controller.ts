import type { NextFunction, Request, Response } from "express";
import type { AppDeps } from "../app.ts";
import { sendConversationMessageService } from "../model/conversationModel.ts";
import { successResponse } from "../utils/responseHandler.ts";

export const sendConversationMessage = (deps: AppDeps) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await sendConversationMessageService(deps, req.params.tenantId as string, req.body);
    return successResponse(res, 202, "Message accepted", result.data);
  } catch (error) {
    next(error);
  }
};
