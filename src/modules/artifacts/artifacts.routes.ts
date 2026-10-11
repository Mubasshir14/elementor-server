import { ProjectRole } from "../../generated/prisma/client.js";
import { Router } from "express";
import { z } from "zod";
import { pipeline } from "node:stream/promises";
import { prisma } from "../../infrastructure/database/prisma.js";
import { storage } from "../../infrastructure/storage/local.js";
import { HttpError } from "../../middleware/errors.js";
import { authenticatedUserId } from "../auth/auth.middleware.js";
import { requireProjectRole } from "../projects/access.js";

export const artifactsRouter = Router();

artifactsRouter.get("/conversions/:conversionId/artifacts", async (req, res) => {
  const conversionId = z.string().cuid().parse(req.params.conversionId);
  const conversion = await prisma.conversionJob.findUnique({
    where: { id: conversionId },
    select: { id: true, projectId: true },
  });
  if (!conversion) throw new HttpError(404, "CONVERSION_NOT_FOUND", "Conversion was not found");
  await requireProjectRole(conversion.projectId, authenticatedUserId(req), Object.values(ProjectRole));
  const artifacts = await prisma.artifact.findMany({
    where: { conversionId: conversion.id, status: "READY" },
    select: { id: true, fileName: true, contentType: true, sizeBytes: true, sha256: true, createdAt: true },
  });
  res.json({
    artifacts: artifacts.map((artifact) => ({ ...artifact, sizeBytes: artifact.sizeBytes.toString() })),
  });
});

artifactsRouter.get("/artifacts/:artifactId/download", async (req, res) => {
  const id = z.string().cuid().parse(req.params.artifactId);
  const artifact = await prisma.artifact.findFirst({
    where: { id, status: "READY" },
    select: { id: true, projectId: true, storageKey: true, fileName: true, contentType: true, sizeBytes: true },
  });
  if (!artifact) throw new HttpError(404, "ARTIFACT_NOT_FOUND", "Artifact was not found");
  await requireProjectRole(artifact.projectId, authenticatedUserId(req), Object.values(ProjectRole));
  const stored = await storage.stat(artifact.storageKey);
  if (!stored) throw new HttpError(404, "ARTIFACT_FILE_NOT_FOUND", "Artifact file was not found");
  if (stored.sizeBytes !== Number(artifact.sizeBytes)) {
    throw new HttpError(500, "ARTIFACT_STORAGE_MISMATCH", "Stored artifact metadata is inconsistent");
  }
  const stream = await storage.createReadStream(artifact.storageKey);
  const safeName = artifact.fileName.replace(/[\r\n"\\/]/g, "_");
  res.status(200);
  res.setHeader("Content-Type", artifact.contentType);
  res.setHeader("Content-Length", stored.sizeBytes);
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`);
  res.setHeader("Cache-Control", "private, no-store");
  await pipeline(stream, res);
});
