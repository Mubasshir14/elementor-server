import { Router } from "express";

// Shared router for source imports. The Figma OAuth authorize/status/callback
// routes and the remote file-URL import were removed: Figma intake now uses
// direct file upload through the authenticated upload API. Framer published-site
// analysis and the import list remain and are registered by remote-imports.
export const sourceImportsRouter = Router();

