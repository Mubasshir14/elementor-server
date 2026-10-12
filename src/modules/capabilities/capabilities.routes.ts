import { Router } from "express";
import { capabilitiesResponseSchema } from "./capabilities.schema.js";
import { env } from "../../config/env.js";
import { authenticatedUserId } from "../auth/auth.middleware.js";
import {
  evaluateSourceAvailability,
  evaluateTargetAvailability,
} from "./capabilities.availability.js";

export const capabilitiesRouter = Router();

capabilitiesRouter.get("/", async (req, res) => {
  authenticatedUserId(req);

  // Runtime availability — never hardcoded. Each source reports whether its own
  // Markdown rules, the AI provider, and storage are actually usable.
  const react = evaluateSourceAvailability("react-next-zip");
  const figma = evaluateSourceAvailability("figma");
  const framer = evaluateSourceAvailability("framer");
  const target = evaluateTargetAvailability();

  const capabilities = capabilitiesResponseSchema.parse({
    sourceTypes: [
      {
        id: "react-next-zip",
        label: "React / Next.js Project ZIP",
        status: "available",
        acceptedFormats: [".zip"],
        maxBytes: env.UPLOAD_MAX_BYTES,
        frameworkAutoDetection: true,
        conversionAvailable: react.available,
        unavailableReason: react.unavailableReason ?? "React/Next.js ZIP conversion is available.",
        importMethod: "zip-upload",
        authorization: { type: "none", connected: false, scopes: [] },
      },
      {
        id: "figma",
        label: "Figma Design File",
        status: "available",
        acceptedFormats: [".fig", ".json"],
        maxBytes: env.UPLOAD_MAX_BYTES,
        frameworkAutoDetection: false,
        conversionAvailable: figma.available,
        unavailableReason: figma.unavailableReason ?? "Figma conversion is available.",
        importMethod: "file-upload",
        authorization: { type: "none", connected: false, scopes: [] },
      },
      {
        id: "framer",
        label: "Framer Project",
        status: "available",
        acceptedFormats: [],
        maxBytes: null,
        frameworkAutoDetection: false,
        conversionAvailable: framer.available,
        unavailableReason: framer.unavailableReason ?? "Framer conversion is available.",
        importMethod: "published-site-url",
        authorization: { type: "none", connected: false, scopes: [] },
      },
      {
        id: "screenshot",
        label: "Screenshot",
        status: "unavailable",
        acceptedFormats: [],
        maxBytes: null,
        frameworkAutoDetection: false,
        conversionAvailable: false,
        unavailableReason: "No screenshot analysis or design-to-DIR pipeline is implemented.",
        importMethod: "unavailable",
        authorization: { type: "none", connected: false, scopes: [] },
      },
    ],
    target: {
      platform: "elementor",
      status: target.available ? "available" : "unavailable",
      architectures: [],
      licenseModes: [],
      unavailableReason: target.unavailableReason ?? "Native Elementor conversion is available.",
    },
    defaults: null,
  });
  res.json(capabilities);
});

