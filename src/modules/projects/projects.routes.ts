import { ProjectRole } from "../../generated/prisma/client.js";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../infrastructure/database/prisma.js";
import { storage } from "../../infrastructure/storage/local.js";
import { authenticatedUserId } from "../auth/auth.middleware.js";
import { requireProjectRole } from "./access.js";
import { HttpError } from "../../middleware/errors.js";

export const projectsRouter = Router();

const projectBody = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const projectId = z.string().cuid();

projectsRouter.get("/", async (req, res) => {
  const projects = await prisma.project.findMany({
    where: { members: { some: { userId: authenticatedUserId(req) } } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, createdAt: true, updatedAt: true },
  });
  res.json({ projects });
});

projectsRouter.post("/", async (req, res) => {
  const body = projectBody.parse(req.body);
  const project = await prisma.project.create({
    data: {
      name: body.name,
      members: { create: { userId: authenticatedUserId(req), role: ProjectRole.OWNER } },
    },
    select: { id: true, name: true, createdAt: true, updatedAt: true },
  });
  res.status(201).json({ project });
});

projectsRouter.get("/:projectId", async (req, res) => {
  const id = projectId.parse(req.params.projectId);
  const userId = authenticatedUserId(req);
  await requireProjectRole(id, userId, Object.values(ProjectRole));
  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, name: true, createdAt: true, updatedAt: true },
  });
  if (!project) throw new HttpError(404, "PROJECT_NOT_FOUND", "Project was not found");
  res.json({ project });
});

projectsRouter.patch("/:projectId", async (req, res) => {
  const id = projectId.parse(req.params.projectId);
  const body = projectBody.parse(req.body);
  await requireProjectRole(id, authenticatedUserId(req), [ProjectRole.OWNER, ProjectRole.EDITOR]);
  const project = await prisma.project.update({
    where: { id },
    data: { name: body.name },
    select: { id: true, name: true, createdAt: true, updatedAt: true },
  });
  res.json({ project });
});

projectsRouter.delete("/:projectId", async (req, res) => {
  const id = projectId.parse(req.params.projectId);
  await requireProjectRole(id, authenticatedUserId(req), [ProjectRole.OWNER]);
  const [uploads, artifacts] = await Promise.all([
    prisma.upload.findMany({ where: { projectId: id }, select: { storageKey: true } }),
    prisma.artifact.findMany({ where: { projectId: id }, select: { storageKey: true } }),
  ]);
  await prisma.project.delete({ where: { id } });
  const storageKeys = [...uploads, ...artifacts].map(({ storageKey }) => storageKey);
  const cleanupResults = await Promise.all(
    storageKeys.map(async (storageKey) => {
      try {
        await storage.delete(storageKey);
        return { storageKey, error: null };
      } catch (error) {
        return { storageKey, error };
      }
    }),
  );
  const failedCleanup = cleanupResults.filter((result) => result.error !== null);
  if (failedCleanup.length > 0) {
    console.error("Project storage cleanup failed", {
      projectId: id,
      failures: failedCleanup.map(({ storageKey, error }) => ({
        storageKey,
        errorName: error instanceof Error ? error.name : "unknown",
      })),
    });
    throw new HttpError(500, "STORAGE_CLEANUP_FAILED", "Project was deleted, but some stored files require cleanup");
  }
  res.status(204).end();
});
