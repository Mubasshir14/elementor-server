// READ-ONLY inspection of a single conversion job. No AI calls. No writes.
// Prints non-sensitive fields only (no credentials, no presigned URLs).
import "dotenv/config";
import { prisma } from "../src/infrastructure/database/prisma.js";
import { storage } from "../src/infrastructure/storage/local.js";

const CONVERSION_ID = process.argv[2] ?? "cmv6mtss20003korfl7asgn1d";

async function main() {
  const job = await prisma.conversionJob.findUnique({
    where: { id: CONVERSION_ID },
    include: {
      stages: { orderBy: { position: "asc" } },
      validationReport: true,
      artifacts: true,
      upload: { select: { id: true, sourceImportId: true, status: true, storageKey: true } },
    },
  });

  if (!job) {
    console.log(JSON.stringify({ found: false, conversionId: CONVERSION_ID }));
    await prisma.$disconnect();
    return;
  }

  const out: Record<string, unknown> = {
    found: true,
    conversionId: job.id,
    projectId: job.projectId,
    uploadId: job.uploadId ?? null,
    uploadSourceImportId: job.upload?.sourceImportId ?? null,
    status: job.status,
    errorCode: job.errorCode ?? null,
    errorMessage: job.errorMessage ?? null,
    attempt: job.attempt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    stages: job.stages.map((s) => ({
      name: s.name,
      status: s.status,
      outputKey: s.outputKey ?? null,
      diagnostics: s.diagnostics ?? null,
    })),
    validationReport: job.validationReport
      ? { diagnostics: job.validationReport.diagnostics ?? null }
      : null,
    artifacts: job.artifacts.map((a) => ({
      id: a.id,
      status: a.status,
      fileName: a.fileName,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes.toString(),
      sha256: a.sha256,
      storageKey: a.storageKey,
    })),
  };

  // Verify the private B2 object exists and matches the recorded size.
  const readyArtifact = job.artifacts.find((a) => a.status === "READY");
  if (readyArtifact) {
    const stat = await storage.stat(readyArtifact.storageKey);
    out.b2Object = {
      storageKey: readyArtifact.storageKey,
      exists: stat !== null,
      sizeBytes: stat ? stat.sizeBytes : null,
      sizeMatchesRecord: stat ? stat.sizeBytes === Number(readyArtifact.sizeBytes) : false,
    };
  } else {
    out.b2Object = { present: false };
  }

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("INSPECT_ERROR:", err instanceof Error ? err.message : String(err));
  await prisma.$disconnect();
  process.exitCode = 1;
});
