import type { NextFunction, Request, Response } from "express";
import { log } from "../../../log.ts";
import { errorResponse } from "../../utils/responseHandler.ts";

const errorHandling = (
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (res.headersSent) return next(err);

  // The body parser's errors (bad JSON, too large): the caller's mistake, safe to show.
  const { status, expose } = err as { status?: unknown; expose?: unknown };
  if (typeof status === "number" && status >= 400 && status < 500 && expose === true) {
    return errorResponse(
      res,
      status,
      status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST_BODY",
      err.message,
    );
  }

  log("error", "request failed", { error: err.stack ?? String(err) });
  return errorResponse(res, 500, "INTERNAL_SERVER_ERROR", "Internal Server Error");
};

export default errorHandling;
