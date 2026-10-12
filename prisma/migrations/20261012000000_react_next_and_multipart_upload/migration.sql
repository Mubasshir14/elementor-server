-- AlterEnum
ALTER TYPE "SourcePlatform" ADD VALUE 'REACT_NEXT_ZIP';

-- AlterEnum
ALTER TYPE "SourceImportKind" ADD VALUE 'REACT_NEXT_PROJECT';

-- AlterTable
ALTER TABLE "Upload" ADD COLUMN "multipartUploadId" TEXT,
ADD COLUMN "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Upload_status_expiresAt_idx" ON "Upload"("status", "expiresAt");

