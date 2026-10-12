import {
  createFramerImportHandler,
  listProjectImportsHandler,
} from "../framer/framer.controller.js";
import { sourceImportsRouter } from "./source-imports.routes.js";

sourceImportsRouter.post("/projects/:projectId/imports/framer", createFramerImportHandler);
sourceImportsRouter.get("/projects/:projectId/imports", listProjectImportsHandler);
