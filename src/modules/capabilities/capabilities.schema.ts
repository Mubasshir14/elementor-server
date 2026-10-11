import { z } from "zod";

export const sourceTypes = ["react-next-zip", "figma", "framer", "screenshot"] as const;
export const detectedFrameworks = ["react", "nextjs"] as const;
export const elementorArchitectures = ["atomic", "legacy", "hybrid"] as const;
export const elementorLicenseModes = ["free", "pro", "hybrid"] as const;

export const conversionSettingsBaseSchema = z.object({
  sourceType: z.enum(sourceTypes),
  detectedFramework: z.enum(detectedFrameworks).optional(),
  sourceImportId: z.string().cuid().optional(),
  targetProfile: z.object({
    platform: z.literal("elementor"),
    architecture: z.enum(elementorArchitectures),
    licenseMode: z.enum(elementorLicenseModes),
  }).strict(),
}).strict();

export const conversionSettingsSchema = conversionSettingsBaseSchema.superRefine((value, context) => {
  if (value.sourceType === "react-next-zip" && !value.detectedFramework) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["detectedFramework"],
      message: "React/Next.js conversions require the detected framework from upload validation",
    });
  }
  if ((value.sourceType === "figma" || value.sourceType === "framer") && !value.sourceImportId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceImportId"],
      message: "Figma and Framer conversions require a validated source import reference",
    });
  }
});

export const sourceImportMethodSchema = z.enum(["zip-upload", "file-upload", "published-site-url", "unavailable"]);

export const capabilitiesResponseSchema = z.object({
  sourceTypes: z.array(z.object({
    id: z.enum(sourceTypes),
    label: z.string().min(1),
    status: z.enum(["available", "unavailable", "needs-configuration"]),
    acceptedFormats: z.array(z.string()),
    maxBytes: z.number().int().positive().nullable(),
    frameworkAutoDetection: z.boolean(),
    conversionAvailable: z.boolean(),
    unavailableReason: z.string().optional(),
    importMethod: sourceImportMethodSchema,
    authorization: z.object({
      type: z.enum(["none"]),
      connected: z.boolean(),
      connectUrl: z.string().optional(),
      scopes: z.array(z.string()).default([]),
    }).strict(),
  }).strict()).length(sourceTypes.length),
  target: z.object({
    platform: z.literal("elementor"),
    status: z.literal("unavailable"),
    architectures: z.array(z.enum(elementorArchitectures)).length(0),
    licenseModes: z.array(z.enum(elementorLicenseModes)).length(0),
    unavailableReason: z.string().min(1),
  }).strict(),
  defaults: z.null(),
}).strict().superRefine((response, context) => {
  if (new Set(response.sourceTypes.map(({ id }) => id)).size !== sourceTypes.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceTypes"],
      message: "Each source type must be listed exactly once",
    });
  }
  for (const source of response.sourceTypes) {
    if (source.id === "react-next-zip") {
      if (
        source.status !== "available" ||
        source.acceptedFormats.length !== 1 ||
        source.acceptedFormats[0] !== ".zip" ||
        source.maxBytes === null ||
        !source.frameworkAutoDetection ||
        source.conversionAvailable ||
        !source.unavailableReason ||
        source.importMethod !== "zip-upload" ||
        source.authorization.type !== "none" ||
        source.authorization.connected !== false
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sourceTypes"],
          message: "React/Next.js ZIP intake must expose only the verified upload and inspection capabilities",
        });
      }
      continue;
    }
    if (source.id === "figma") {
      const figmaFormats = source.acceptedFormats as unknown[];
      const hasFig = figmaFormats.includes(".fig");
      const hasJson = figmaFormats.includes(".json");
      if (
        source.status !== "available" ||
        !hasFig || !hasJson || figmaFormats.length !== 2 ||
        source.maxBytes === null ||
        source.frameworkAutoDetection ||
        source.conversionAvailable ||
        !source.unavailableReason ||
        source.importMethod !== "file-upload" ||
        source.authorization.type !== "none" ||
        source.authorization.connected !== false
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sourceTypes"],
          message: "Figma must use direct file upload of native .fig and REST API file JSON without any OAuth, file URL, or account connection",
        });
      }
      continue;
    }
    if (source.id === "framer") {
      if (
        source.status !== "available" ||
        source.acceptedFormats.length !== 0 ||
        source.maxBytes !== null ||
        source.frameworkAutoDetection ||
        source.conversionAvailable ||
        !source.unavailableReason ||
        source.importMethod !== "published-site-url" ||
        source.authorization.type !== "none" ||
        source.authorization.connected !== false
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sourceTypes"],
          message: "Framer must use the published-site URL import method without advertising file uploads",
        });
      }
      continue;
    }
    if (
      source.status !== "unavailable" ||
      source.acceptedFormats.length !== 0 ||
      source.maxBytes !== null ||
      source.frameworkAutoDetection ||
      source.conversionAvailable ||
      !source.unavailableReason ||
      source.importMethod !== "unavailable"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceTypes"],
        message: "Unimplemented source adapters must not advertise formats or capabilities",
      });
    }
  }
});
