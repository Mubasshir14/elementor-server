import { z } from "zod";

export const framerProjectParamsSchema = z.object({
  projectId: z.string().cuid(),
});

export const framerImportBodySchema = z
  .object({
    siteUrl: z.string().trim().min(1).max(2_048),
  })
  .strict();

