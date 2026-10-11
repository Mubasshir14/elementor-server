import { Router } from "express";
import {
  capabilitiesResponseSchema,
} from "./capabilities.schema.js";
import { env } from "../../config/env.js";
import { authenticatedUserId } from "../auth/auth.middleware.js";

export const capabilitiesRouter = Router();

capabilitiesRouter.get("/", async (req, res) => {
  authenticatedUserId(req);
  const capabilities = capabilitiesResponseSchema.parse({
    sourceTypes: [
      {
        id: "react-next-zip",
        label: "React / Next.js Project ZIP",
        status: "available",
        acceptedFormats: [".zip"],
        maxBytes: env.UPLOAD_MAX_BYTES,
        frameworkAutoDetection: true,
        conversionAvailable: false,
        unavailableReason: "Source intake and framework detection are implemented; conversion is disabled until the approved DIR and Elementor compiler are available.",
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
        conversionAvailable: false,
        unavailableReason: "Native .fig files and Figma REST API file JSON exports are uploaded directly and parsed locally. No Figma account, OAuth, file URL, or API token is required. Conversion remains disabled until the approved DIR and Elementor compiler are available.",
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
        conversionAvailable: false,
        unavailableReason: "Framer import supports published-site URL analysis only; conversion remains disabled until the approved DIR and Elementor compiler are available.",
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
      status: "unavailable",
      architectures: [],
      licenseModes: [],
      unavailableReason: "The canonical DIR schema and Elementor compilation pipeline are not present in this repository.",
    },
    defaults: null,
  });
  res.json(capabilities);
});
