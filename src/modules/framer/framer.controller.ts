import type { Request, Response } from "express";
import { ProjectRole } from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { authenticatedUserId } from "../auth/auth.middleware.js";
import { requireProjectRole } from "../projects/access.js";
import { createFramerSiteImport } from "./framer.service.js";
import { framerImportBodySchema, framerProjectParamsSchema } from "./framer.validator.js";

export async function createFramerImportHandler(req: Request, res: Response): Promise<void> {
  const { projectId } = framerProjectParamsSchema.parse(req.params);
  const body = framerImportBodySchema.parse(req.body);
  const userId = authenticatedUserId(req);
  await requireProjectRole(projectId, userId, [ProjectRole.OWNER, ProjectRole.EDITOR]);

  const sourceImport = await createFramerSiteImport({
    projectId,
    userId,
    siteUrl: body.siteUrl,
  });

  res.status(201).json({ sourceImport });
}

export async function listProjectImportsHandler(req: Request, res: Response): Promise<void> {
  const { projectId } = framerProjectParamsSchema.parse(req.params);
  const userId = authenticatedUserId(req);
  await requireProjectRole(projectId, userId, Object.values(ProjectRole));

  const imports = await prisma.sourceImport.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      kind: true,
      status: true,
      inputUrl: true,
      fileKey: true,
      fileName: true,
      summary: true,
      diagnostics: true,
      errorCode: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  res.json({ sourceImports: imports });
}

