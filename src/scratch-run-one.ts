import dotenv from "dotenv";
dotenv.config({ path: "server/.env" });
process.env.WORKER_LIBRARY_MODE = "1";
import { processNextPendingConversion } from "./worker.js";
import { prisma } from "./infrastructure/database/prisma.js";

async function main() {
  console.log(
    "Calling processNextPendingConversion directly in diagnostic mode...",
  );
  const convId = await processNextPendingConversion("diag-worker-1" as any);
  console.log("Processed conversion:", convId);

  const job = await prisma.conversionJob.findUnique({
    where: { id: "cmv6fytwj0000o0rfwsegucfw" },
    include: { stages: true, artifacts: true },
  });
  console.log("Final job status:", job?.status);
  console.log("Error:", job?.errorCode, job?.errorMessage);
  console.log(
    "Stages:",
    job?.stages.map((s) => ({ name: s.name, status: s.status })),
  );
  console.log("Artifacts:", job?.artifacts);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Diagnostic execution error:", err);
  process.exit(1);
});
