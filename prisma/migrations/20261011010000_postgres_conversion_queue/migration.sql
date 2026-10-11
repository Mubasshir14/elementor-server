ALTER TABLE "ConversionJob"
  DROP COLUMN "queueJobId",
  ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lockedAt" TIMESTAMP(3),
  ADD COLUMN "workerId" TEXT;

CREATE INDEX "ConversionJob_status_availableAt_createdAt_idx"
  ON "ConversionJob"("status", "availableAt", "createdAt");

CREATE INDEX "ConversionJob_status_lockedAt_idx"
  ON "ConversionJob"("status", "lockedAt");
