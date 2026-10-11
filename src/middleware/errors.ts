import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (res.headersSent) {
    _next(error);
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        issues: error.issues.map(({ path, code, message }) => ({ path, code, message })),
      },
    });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
    return;
  }
  if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") {
    res.status(413).json({ error: { code: "REQUEST_TOO_LARGE", message: "Request body exceeds the allowed size" } });
    return;
  }
  console.error("Unhandled request error", error instanceof Error ? error.name : "unknown");
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
};
