import type { Request, Response } from "express";
import { ProjectRole } from "../../generated/prisma/client.js";
import { authenticatedUserId } from "../auth/auth.middleware.js";
import { requireProjectRole } from "../projects/access.js";
import { getFigmaImportDetail, listFigmaImportsForProject } from "./figma.service.js";
import { figmaImportParamsSchema, figmaProjectParamsSchema } from "./figma.validator.js";

export async function listFigmaImportsHandler(req: Request, res: Response): Promise<void> {
  const userId = authenticatedUserId(req);
  const { projectId } = figmaProjectParamsSchema.parse(req.params);
  await requireProjectRole(projectId, userId, Object.values(ProjectRole));

  const imports = await listFigmaImportsForProject({ projectId });
  res.json({ imports });
}

export async function getFigmaImportDetailHandler(req: Request, res: Response): Promise<void> {
  const userId = authenticatedUserId(req);
  const { projectId, importId } = figmaImportParamsSchema.parse(req.params);
  await requireProjectRole(projectId, userId, Object.values(ProjectRole));

  const detail = await getFigmaImportDetail({ projectId, importId });
  res.json(detail);
}

