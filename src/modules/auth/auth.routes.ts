import argon2 from "argon2";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../../config/env.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { HttpError } from "../../middleware/errors.js";
import { authenticatedSessionId, authenticatedUserId, requireAuth } from "./auth.middleware.js";

export const authRouter = Router();

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
}).strict();

async function createSession(userId: string) {
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
  const session = await prisma.session.create({ data: { userId, expiresAt } });
  const token = jwt.sign(
    { sid: session.id },
    env.JWT_SECRET,
    { subject: userId, issuer: "design-to-elementor-api", expiresIn: "12h" },
  );
  return { token, expiresAt };
}

authRouter.post("/register", async (req, res) => {
  const body = credentialsSchema.parse(req.body);
  const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
  try {
    const user = await prisma.user.create({
      data: { email: body.email, passwordHash },
      select: { id: true, email: true },
    });
    const session = await createSession(user.id);
    res.status(201).json({ user, ...session });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      throw new HttpError(409, "EMAIL_IN_USE", "An account with this email already exists");
    }
    throw error;
  }
});

authRouter.post("/login", async (req, res) => {
  const body = credentialsSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (!user || !(await argon2.verify(user.passwordHash, body.password))) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }
  res.json({
    user: { id: user.id, email: user.email },
    ...await createSession(user.id),
  });
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  await prisma.session.update({
    where: { id: authenticatedSessionId(req) },
    data: { revokedAt: new Date() },
  });
  res.status(204).end();
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: authenticatedUserId(req) },
    select: { id: true, email: true, createdAt: true },
  });
  if (!user) throw new HttpError(401, "INVALID_SESSION", "Session is no longer valid");
  res.json({ user });
});
