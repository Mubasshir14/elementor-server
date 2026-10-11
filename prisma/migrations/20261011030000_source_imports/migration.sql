-- CreateEnum
CREATE TYPE "SourceImportKind" AS ENUM ('FIGMA_FILE', 'FRAMER_SITE');

-- CreateEnum
CREATE TYPE "SourceImportStatus" AS ENUM ('READY', 'FAILED');

-- AlterTable
ALTER TABLE "Upload" ADD COLUMN "sourceImportId" TEXT,
ADD COLUMN "validation" JSONB;

-- CreateTable
CREATE TABLE "FigmaConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "accessTokenCiphertext" TEXT NOT NULL,
    "refreshTokenCiphertext" TEXT,
    "scopes" TEXT[] NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "figmaUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FigmaConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceImport" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "kind" "SourceImportKind" NOT NULL,
    "status" "SourceImportStatus" NOT NULL DEFAULT 'READY',
    "inputUrl" TEXT,
    "fileKey" TEXT,
    "fileName" TEXT,
    "snapshotKey" TEXT,
    "summary" JSONB,
    "diagnostics" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FigmaConnection_userId_createdAt_idx" ON "FigmaConnection"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "FigmaConnection_projectId_createdAt_idx" ON "FigmaConnection"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "SourceImport_projectId_createdAt_idx" ON "SourceImport"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "SourceImport_projectId_kind_createdAt_idx" ON "SourceImport"("projectId", "kind", "createdAt");

-- AddForeignKey
ALTER TABLE "FigmaConnection" ADD CONSTRAINT "FigmaConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FigmaConnection" ADD CONSTRAINT "FigmaConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceImport" ADD CONSTRAINT "SourceImport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceImport" ADD CONSTRAINT "SourceImport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "SourceImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
