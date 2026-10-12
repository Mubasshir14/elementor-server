import { Router } from "express";
import { getReactNextInspectionHandler } from "./react-nextjs.controller.js";

export const reactNextjsRouter = Router();

reactNextjsRouter.get(
  "/projects/:projectId/react-nextjs/uploads/:uploadId/inspection",
  getReactNextInspectionHandler,
);

