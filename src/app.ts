import cors from "cors";
import express, { Router } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import { prisma } from "./infrastructure/database/prisma.js";
import { storage } from "./infrastructure/storage/local.js";
import { errorHandler, HttpError } from "./middleware/errors.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { requireAuth } from "./modules/auth/auth.middleware.js";
import { projectsRouter } from "./modules/projects/projects.routes.js";
import { uploadsRouter } from "./modules/uploads/uploads.routes.js";
import { conversionsRouter } from "./modules/conversions/conversions.routes.js";
import { rulesRouter } from "./modules/rule-files/rules.routes.js";
import { sitesRouter } from "./modules/wordpress-sites/sites.routes.js";
import { artifactsRouter } from "./modules/artifacts/artifacts.routes.js";
import { capabilitiesRouter } from "./modules/capabilities/capabilities.routes.js";
import { sourceImportsRouter } from "./modules/uploads/source-imports.routes.js";
import "./modules/uploads/remote-imports.routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY_HOPS);
  app.use(helmet());
  app.use(cors({
    origin: (origin, callback) => callback(null, !origin || origin === env.WEB_ORIGIN),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    credentials: false,
  }));
  app.use(express.json({ limit: "256kb", strict: true }));
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }));

  const v1 = Router();
  v1.get("/health/live", (_req, res) => res.json({ status: "live" }));
  v1.get("/health/ready", async (_req, res) => {
    try {
      await Promise.all([
        prisma.$queryRaw`SELECT 1`,
        storage.ready(),
      ]);
      res.json({ status: "ready" });
    } catch (error) {
      console.error("Readiness check failed", error instanceof Error ? error.name : "unknown");
      res.status(503).json({ status: "not_ready" });
    }
  });
  v1.use("/auth", rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }), authRouter);
  v1.use(requireAuth);
  v1.use("/capabilities", capabilitiesRouter);
  v1.use(sourceImportsRouter);
  v1.use("/projects", projectsRouter);
  v1.use(uploadsRouter);
  v1.use(conversionsRouter);
  v1.use("/rules", rulesRouter);
  v1.use("/sites", sitesRouter);
  v1.use(artifactsRouter);
  v1.use((_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "Endpoint was not found")));
  app.use("/api/v1", v1);
  app.use(errorHandler);
  return app;
}
