import type { Request, Response } from "express";
import { ProjectRole } from "../../generated/prisma/client.js";
import { authenticatedUserId } from "../auth/auth.middleware.js";
import { requireProjectRole } from "../projects/access.js";
import { getReactNextUploadInspection } from "./react-nextjs.service.js";
import { reactNextProjectUploadParamsSchema } from "./react-nextjs.validator.js";

export async function getReactNextInspectionHandler(req: Request, res: Response): Promise<void> {
  const userId = authenticatedUserId(req);
  const { projectId, uploadId } = reactNextProjectUploadParamsSchema.parse(req.params);
  await requireProjectRole(projectId, userId, Object.values(ProjectRole));

  const result = await getReactNextUploadInspection({
    projectId,
    userId,
    uploadId,
  });

  res.json(result);
}

