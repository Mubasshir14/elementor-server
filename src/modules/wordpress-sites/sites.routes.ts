import { ProjectRole } from "../../generated/prisma/client.js";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../infrastructure/database/prisma.js";
import { decryptSiteCredential, encryptSiteCredential } from "../../infrastructure/wordpress/credentials.js";
import { bridgeRequest, isBridgeCapabilities } from "../../infrastructure/wordpress/bridge-client.js";
import { HttpError } from "../../middleware/errors.js";
import { authenticatedUserId } from "../auth/auth.middleware.js";
import { requireProjectRole } from "../projects/access.js";

export const sitesRouter = Router();
const siteIdSchema = z.string().cuid();

sitesRouter.post("/", async (req, res) => {
  const body = z.object({
    projectId: z.string().cuid(),
    baseUrl: z.string().url().max(2_048),
    username: z.string().trim().min(1).max(150),
    applicationPassword: z.string().min(12).max(512),
  }).strict().parse(req.body);
  const userId = authenticatedUserId(req);
  await requireProjectRole(body.projectId, userId, [ProjectRole.OWNER, ProjectRole.EDITOR]);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(body.baseUrl);
  } catch {
    throw new HttpError(400, "INVALID_SITE_URL", "Site URL is invalid");
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new HttpError(400, "UNSAFE_SITE_URL", "WordPress site must use HTTPS and must not include credentials");
  }
  const credentialCiphertext = encryptSiteCredential(
    `${body.username}:${body.applicationPassword}`,
  );
  const site = await prisma.connectedWordPressSite.create({
    data: {
      projectId: body.projectId,
      baseUrl: `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/+$/, "")}`,
      credentialCiphertext,
    },
    select: { id: true, baseUrl: true, createdAt: true },
  });
  res.status(201).json({ site });
});

sitesRouter.post("/:siteId/verify", async (req, res) => {
  z.object({}).strict().parse(req.body);
  const id = siteIdSchema.parse(req.params.siteId);
  const site = await prisma.connectedWordPressSite.findFirst({
    where: { id, revokedAt: null },
  });
  if (!site) throw new HttpError(404, "SITE_NOT_FOUND", "Connected site was not found");
  await requireProjectRole(site.projectId, authenticatedUserId(req), Object.values(ProjectRole));
  if (!site.credentialCiphertext) {
    throw new HttpError(409, "SITE_CREDENTIAL_MISSING", "Connected site does not have credentials");
  }
  const capabilities = await bridgeRequest(
    site.baseUrl,
    "wp-json/design-to-elementor/v1/capabilities",
    decryptSiteCredential(site.credentialCiphertext),
    isBridgeCapabilities,
  );
  const verified = await prisma.connectedWordPressSite.update({
    where: { id },
    data: {
      verifiedAt: new Date(),
      capabilities: {
        bridgeVersion: capabilities.bridgeVersion,
        wordpressVersion: capabilities.wordpressVersion,
        elementorVersion: capabilities.elementorVersion,
        elementorProActive: capabilities.elementorProActive,
        widgets: capabilities.widgets,
        features: capabilities.features,
        nativeDocumentWrite: capabilities.nativeDocumentWrite,
      },
    },
    select: { id: true, baseUrl: true, verifiedAt: true, capabilities: true },
  });
  res.json({ site: verified });
});

sitesRouter.post("/:siteId/publish", async (req, res) => {
  const body = z.object({
    conversionId: z.string().cuid(),
    artifactId: z.string().cuid(),
    idempotencyKey: z.string().trim().min(8).max(128),
    confirm: z.literal(true),
  }).strict().parse(req.body);
  const id = siteIdSchema.parse(req.params.siteId);
  const site = await prisma.connectedWordPressSite.findFirst({
    where: { id, revokedAt: null },
  });
  if (!site) throw new HttpError(404, "SITE_NOT_FOUND", "Connected site was not found");
  await requireProjectRole(site.projectId, authenticatedUserId(req), [
    ProjectRole.OWNER,
    ProjectRole.EDITOR,
  ]);
  const conversion = await prisma.conversionJob.findFirst({
    where: { id: body.conversionId, projectId: site.projectId },
    select: { status: true, errorCode: true },
  });
  if (!conversion || conversion.status !== "SUCCEEDED") {
    throw new HttpError(409, "CONVERSION_NOT_PUBLISHABLE", "Only a successfully validated conversion can be published");
  }
  const artifact = await prisma.artifact.findFirst({
    where: { id: body.artifactId, conversionId: body.conversionId, projectId: site.projectId, status: "READY" },
    select: { id: true },
  });
  if (!artifact) throw new HttpError(404, "ARTIFACT_NOT_FOUND", "Conversion artifact was not found");
  if (!site.verifiedAt || !site.capabilities || !site.credentialCiphertext) {
    throw new HttpError(409, "SITE_NOT_VERIFIED", "Verify site capabilities before publishing");
  }
  throw new HttpError(
    501,
    "NATIVE_PUBLISH_ADAPTER_UNVERIFIED",
    "Native document write operations are disabled until the bridge adapter is verified against a supported site",
  );
});

sitesRouter.delete("/:siteId", async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const id = siteIdSchema.parse(req.params.siteId);
  const site = await prisma.connectedWordPressSite.findFirst({ where: { id, revokedAt: null } });
  if (!site) throw new HttpError(404, "SITE_NOT_FOUND", "Connected site was not found");
  await requireProjectRole(site.projectId, authenticatedUserId(req), [ProjectRole.OWNER]);
  await prisma.connectedWordPressSite.update({
    where: { id },
    data: { revokedAt: new Date(), credentialCiphertext: null },
  });
  res.status(204).end();
});
