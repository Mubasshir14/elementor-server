import { Router } from "express";
import {
  createFramerImportHandler,
  listProjectImportsHandler,
} from "./framer.controller.js";

export const framerRouter = Router();

framerRouter.post("/projects/:projectId/imports/framer", createFramerImportHandler);
framerRouter.get("/projects/:projectId/imports", listProjectImportsHandler);

