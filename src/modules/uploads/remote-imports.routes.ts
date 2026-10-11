import { ProjectRole } from "../../generated/prisma/client.js";
import { z } from "zod";
import { prisma } from "../../infrastructure/database/prisma.js";
import { authenticatedUserId } from "../auth/auth.middleware.js";
import { requireProjectRole } from "../projects/access.js";
import { inspectFramerPublishedSite } from "./framer-import.js";
import { framerImportBodySchema } from "./import-helpers.js";
import { sourceImportsRouter } from "./source-imports.routes.js";

// Figma no longer has a remote file-URL import route. Figma design files are
// uploaded directly through the authenticated upload API and parsed locally;
// see uploads.routes.ts. Only Framer published-site analysis and the import
// list are registered here.

sourceImportsRouter.post("/projects/:projectId/imports/framer", async (req, res) => {
  const projectId = z.string().cuid().parse(req.params.projectId);
  const body = framerImportBodySchema.parse(req.body);
  const userId = authenticatedUserId(req);
  await requireProjectRole(projectId, userId, [ProjectRole.OWNER, ProjectRole.EDITOR]);
  const summary = await inspectFramerPublishedSite(body.siteUrl);
  const sourceImport = await prisma.sourceImport.create({
    data: {
      projectId,
      createdById: userId,
      kind: "FRAMER_SITE",
      status: "READY",
      inputUrl: summary.siteUrl,
      fileName: summary.title ?? summary.siteUrl,
      summary: { ...summary } as never,
      diagnostics: summary.diagnostics.map((message) => ({
        code: "FRAMER_PUBLISHED_SITE_ANALYSIS",
        message,
      })) as never,
    },
    select: {
      id: true, kind: true, status: true, inputUrl: true, fileKey: true,
      fileName: true, summary: true, diagnostics: true, createdAt: true, updatedAt: true,
    },
  });
  res.status(201).json({ sourceImport });
});

sourceImportsRouter.get("/projects/:projectId/imports", async (req, res) => {
  const projectId = z.string().cuid().parse(req.params.projectId);
  const userId = authenticatedUserId(req);
  await requireProjectRole(projectId, userId, Object.values(ProjectRole));
  const imports = await prisma.sourceImport.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, kind: true, status: true, inputUrl: true, fileKey: true,
      fileName: true, summary: true, diagnostics: true, errorCode: true,
      errorMessage: true, createdAt: true, updatedAt: true,
    },
  });
  res.json({ sourceImports: imports });
});
