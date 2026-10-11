import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware.js";
import { loadRule } from "./rules.service.js";

export const rulesRouter = Router();

rulesRouter.get("/", requireAuth, async (_req, res) => {
  const files = await Promise.all(
    ["ELEMENTOR_SKILL.md", "FIGMA.md", "FRAMER.md"].map(async (fileName) => {
      const { version, sha256 } = await loadRule(fileName);
      return { fileName, version, sha256 };
    }),
  );
  res.json({ files });
});
