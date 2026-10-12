import { z } from "zod";

export const figmaProjectParamsSchema = z.object({
  projectId: z.string().cuid(),
});

export const figmaImportParamsSchema = z.object({
  projectId: z.string().cuid(),
  importId: z.string().cuid(),
});

export const figmaUploadParamsSchema = z.object({
  projectId: z.string().cuid(),
  uploadId: z.string().uuid(),
});

