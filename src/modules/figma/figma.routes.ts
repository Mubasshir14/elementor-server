import { Router } from "express";
import {
  getFigmaImportDetailHandler,
  listFigmaImportsHandler,
} from "./figma.controller.js";

export const figmaRouter = Router();

figmaRouter.get("/projects/:projectId/figma/imports", listFigmaImportsHandler);
figmaRouter.get("/projects/:projectId/figma/imports/:importId", getFigmaImportDetailHandler);

