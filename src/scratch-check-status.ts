import dotenv from "dotenv";
dotenv.config({ path: "server/.env" });
import { prisma } from "./infrastructure/database/prisma.js";

async function main() {
  const convId = "cmv6fytwj0000o0rfwsegucfw";
  const job = await prisma.conversionJob.findUnique({
    where: { id: convId },
    include: { stages: { orderBy: { position: "asc" } }, artifacts: true, upload: true },
  });
  const sourceImport = await prisma.sourceImport.findUnique({
    where: { id: job?.upload?.sourceImportId || "" },
  });
  console.log("Source Import:", sourceImport);
  console.log("Project ID:", job?.projectId);
  console.log("Worker ID:", job?.workerId);
  console.log("Available At:", job?.availableAt);
  console.log("Error:", job?.errorCode, job?.errorMessage);
  console.log("Stages:", job?.stages.map((s) => ({ name: s.name, status: s.status, diagnostics: s.diagnostics })));
  console.log("Artifacts:", job?.artifacts);
  await prisma.$disconnect();
}

main().catch(console.error);

