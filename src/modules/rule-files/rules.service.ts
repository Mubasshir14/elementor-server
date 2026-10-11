import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../../infrastructure/database/prisma.js";
import { HttpError } from "../../middleware/errors.js";

export type SourcePlatform = "figma" | "framer";

export interface LoadedRule {
  fileName: string;
  version: string;
  sha256: string;
  content: string;
}

const allowedRuleFiles = new Set([
  "ELEMENTOR_SKILL.md",
  "FIGMA.md",
  "FRAMER.md",
]);
const rulesDirectory = fileURLToPath(new URL("../../../rules/", import.meta.url));

function extractVersion(fileName: string, content: string, hash: string): string {
  const metadata = content.match(/^version:\s*([^\r\n]+)$/m)?.[1];
  const prose = content.match(/^\*\*Version:\*\*\s*([^\r\n]+)$/m)?.[1];
  const version = (metadata ?? prose)?.trim();
  return version || `unversioned+${hash.slice(0, 16)}`;
}

export async function loadRule(fileName: string): Promise<LoadedRule> {
  if (!allowedRuleFiles.has(fileName)) {
    throw new HttpError(400, "UNKNOWN_RULE_FILE", "The requested rule file is not approved");
  }
  let content: string;
  try {
    content = await readFile(join(rulesDirectory, fileName), "utf8");
  } catch {
    console.error(`Could not load required rule file ${fileName}`);
    throw new HttpError(503, "RULE_FILE_UNAVAILABLE", `Required rule file ${fileName} is unavailable`);
  }
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  return { fileName, content, sha256, version: extractVersion(fileName, content, sha256) };
}

export async function loadRulesForConversion(source: SourcePlatform): Promise<LoadedRule[]> {
  const files = ["ELEMENTOR_SKILL.md", source === "figma" ? "FIGMA.md" : "FRAMER.md"];
  return Promise.all(files.map(loadRule));
}

export async function persistConversionRules(
  tx: Pick<typeof prisma, "ruleFileVersion" | "conversionRuleVersion">,
  conversionId: string,
  rules: LoadedRule[],
): Promise<void> {
  for (const rule of rules) {
    const version = await tx.ruleFileVersion.upsert({
      where: { fileName_sha256: { fileName: rule.fileName, sha256: rule.sha256 } },
      create: {
        fileName: rule.fileName,
        version: rule.version,
        sha256: rule.sha256,
        content: rule.content,
      },
      update: {},
      select: { id: true },
    });
    await tx.conversionRuleVersion.create({
      data: { conversionId, ruleVersionId: version.id },
    });
  }
}
