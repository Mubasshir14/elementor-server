// Targeted maintenance: correct the demonstrably stale SOURCE_ANALYSIS_RULES_MISSING
// diagnostic on an already-SUCCEEDED conversion. NO AI calls. NO job retry/creation.
//
// Safety:
//  - Read-only DRY RUN by default; writes only when invoked with `--apply`.
//  - Only touches the `source_ir_validation` stage diagnostics and the
//    ValidationReport.diagnostics for the single specified conversion.
//  - Only replaces entries whose code === "SOURCE_ANALYSIS_RULES_MISSING" (the
//    stale fallback). Any OTHER diagnostic is preserved untouched.
//  - Refuses to run unless the job is genuinely SUCCEEDED with a READY artifact
//    whose B2 object exists and matches the recorded size.
//  - Never touches the artifact, job status, other stages, or other records.

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { prisma } from "../src/infrastructure/database/prisma.js";
import { storage } from "../src/infrastructure/storage/local.js";

// Buffer all output and flush to a file at the end so the tsx stdout/tty quirk
// can never swallow the preview. Duplicate every line to stdout too (best-effort).
const OUT = "scripts/fix-stale-diagnostic-out.txt";
let log = "";
function say(line: string): void {
  log += `${line}\n`;
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    /* ignore */
  }
}
function flush(): void {
  writeFileSync(OUT, log, "utf8");
}

const STALE_CODE = "SOURCE_ANALYSIS_RULES_MISSING";
const NEUTRAL_MARKER = { code: "UPSTREAM_STAGE_COMPLETED" };
const STAGE_NAME = "source_ir_validation";

const rawArgs = process.argv.slice(2).filter((a) => !a.startsWith("tsx:") && !a.endsWith(".ts"));
const CONVERSION_ID = rawArgs.find((a) => !a.startsWith("--")) ?? "cmv6mtss20003korfl7asgn1d";
const APPLY = process.argv.includes("--apply");

type Diag = { code?: string; [k: string]: unknown };

function isStale(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as Diag).code === STALE_CODE
  );
}

// Remove stale entries; if nothing genuine remains, substitute the neutral marker
// that a fresh successful run now persists. Genuine diagnostics are preserved.
function correctedDiagnostics(current: unknown): { next: Diag[]; removedCount: number; keptCount: number } {
  const arr = Array.isArray(current) ? (current as Diag[]) : [];
  const kept = arr.filter((e) => !isStale(e));
  const removedCount = arr.length - kept.length;
  const next = kept.length > 0 ? kept : [NEUTRAL_MARKER];
  return { next, removedCount, keptCount: kept.length };
}

async function main() {
  const job = await prisma.conversionJob.findUnique({
    where: { id: CONVERSION_ID },
    include: {
      stages: { where: { name: STAGE_NAME } },
      validationReport: true,
      artifacts: { where: { status: "READY" } },
    },
  });

  if (!job) {
    say(`ABORT: conversion ${CONVERSION_ID} not found.`);
    await prisma.$disconnect(); flush();
    process.exitCode = 1;
    return;
  }

  // Guard: only operate on a genuinely successful job with a verified artifact.
  const readyArtifact = job.artifacts[0];
  if (job.status !== "SUCCEEDED" || !readyArtifact) {
    say(
      `ABORT: job status=${job.status}, readyArtifact=${Boolean(readyArtifact)}. ` +
        `Refusing to modify records for a non-successful or artifact-less job.`,
    );
    await prisma.$disconnect(); flush();
    process.exitCode = 1;
    return;
  }

  const stat = await storage.stat(readyArtifact.storageKey);
  const b2Ok = stat !== null && stat.sizeBytes === Number(readyArtifact.sizeBytes);
  if (!b2Ok) {
    say(
      `ABORT: B2 object for artifact ${readyArtifact.id} is missing or size-mismatched ` +
        `(stat=${stat ? stat.sizeBytes : "null"}, record=${readyArtifact.sizeBytes}). Refusing to modify records.`,
    );
    await prisma.$disconnect(); flush();
    process.exitCode = 1;
    return;
  }

  const stage = job.stages[0];
  const stageCurrent = (stage?.diagnostics ?? null) as unknown;
  const reportCurrent = (job.validationReport?.diagnostics ?? null) as unknown;

  const stageFix = correctedDiagnostics(stageCurrent);
  const reportFix = correctedDiagnostics(reportCurrent);

  say("=== DRY RUN PREVIEW ===");
  say(`conversionId: ${CONVERSION_ID}`);
  say(`status: ${job.status}  attempt: ${job.attempt}`);
  say(`artifact: READY id=${readyArtifact.id} size=${readyArtifact.sizeBytes} sha256=${readyArtifact.sha256}`);
  say(`b2Object: exists sizeMatches=${b2Ok} (key=${readyArtifact.storageKey})`);
  say("");
  say(`stage '${STAGE_NAME}' diagnostics:`);
  say(`  BEFORE: ${JSON.stringify(stageCurrent)}`);
  say(`  AFTER:  ${JSON.stringify(stageFix.next)}  (removed ${stageFix.removedCount}, kept ${stageFix.keptCount})`);
  say(`validationReport diagnostics:`);
  say(`  BEFORE: ${JSON.stringify(reportCurrent)}`);
  say(`  AFTER:  ${JSON.stringify(reportFix.next)}  (removed ${reportFix.removedCount}, kept ${reportFix.keptCount})`);
  say("");

  const stageChanges = stageFix.removedCount > 0 && JSON.stringify(stageFix.next) !== JSON.stringify(stageCurrent);
  const reportChanges = reportFix.removedCount > 0 && JSON.stringify(reportFix.next) !== JSON.stringify(reportCurrent);

  if (!stageChanges && !reportChanges) {
    say("NO-OP: no stale SOURCE_ANALYSIS_RULES_MISSING diagnostic present; nothing to change.");
    await prisma.$disconnect(); flush();
    return;
  }

  if (!APPLY) {
    say("DRY RUN ONLY (no changes written). Re-run with `--apply` to persist the correction.");
    await prisma.$disconnect(); flush();
    return;
  }

  // Transactional apply: update only this conversion's stage + report, guarded on
  // the job still being SUCCEEDED (never flips status, never touches the artifact).
  await prisma.$transaction(async (tx) => {
    const stillSucceeded = await tx.conversionJob.updateMany({
      where: { id: CONVERSION_ID, status: "SUCCEEDED" },
      data: {},
    });
    if (stillSucceeded.count === 0) {
      throw new Error("Job is no longer SUCCEEDED; aborting maintenance write.");
    }
    if (stage && stageChanges) {
      await tx.conversionStage.update({
        where: { conversionId_name: { conversionId: CONVERSION_ID, name: STAGE_NAME } },
        data: { diagnostics: stageFix.next as never },
      });
    }
    if (job.validationReport && reportChanges) {
      await tx.validationReport.update({
        where: { conversionId: CONVERSION_ID },
        data: { diagnostics: reportFix.next as never },
      });
    }
  });

  say("APPLIED: stale diagnostic corrected transactionally. No job status/artifact changes.");

  const verify = await prisma.conversionJob.findUnique({
    where: { id: CONVERSION_ID },
    include: { stages: { where: { name: STAGE_NAME } }, validationReport: true },
  });
  say(`VERIFY stage diagnostics: ${JSON.stringify(verify?.stages[0]?.diagnostics ?? null)}`);
  say(`VERIFY report diagnostics: ${JSON.stringify(verify?.validationReport?.diagnostics ?? null)}`);

  await prisma.$disconnect(); flush();
}

main().catch(async (err) => {
  say(`MAINT_ERROR: ${err instanceof Error ? err.message : String(err)}`);
  await prisma.$disconnect(); flush();
  process.exitCode = 1;
});

