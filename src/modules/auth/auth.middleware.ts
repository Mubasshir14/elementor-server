import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../../infrastructure/database/prisma.js";
import { HttpError } from "../../middleware/errors.js";
import { env } from "../../config/env.js";

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; sessionId: string };
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const match = /^Bearer ([^\s]+)$/.exec(req.header("authorization") ?? "");
    const token = match?.[1];
    if (!token) {
      throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
    }
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      issuer: "design-to-elementor-api",
      algorithms: ["HS256"],
    });
    if (
      typeof decoded === "string" ||
      typeof decoded.sub !== "string" ||
      typeof decoded.sid !== "string"
    ) {
      throw new HttpError(401, "INVALID_SESSION", "Session token is invalid");
    }
    const session = await prisma.session.findFirst({
      where: {
        id: decoded.sid,
        userId: decoded.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, userId: true },
    });
    if (!session) throw new HttpError(401, "INVALID_SESSION", "Session is expired or revoked");
    req.auth = { userId: session.userId, sessionId: session.id };
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      next(new HttpError(401, "INVALID_SESSION", "Session token is invalid or expired"));
      return;
    }
    next(error);
  }
}

export function authenticatedUserId(req: Request): string {
  if (!req.auth) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
  return req.auth.userId;
}

export function authenticatedSessionId(req: Request): string {
  if (!req.auth) throw new HttpError(401, "AUTH_REQUIRED", "Authentication is required");
  return req.auth.sessionId;
}
