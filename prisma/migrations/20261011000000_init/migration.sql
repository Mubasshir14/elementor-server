-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ProjectRole" AS ENUM ('OWNER', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'SCANNING', 'READY', 'REJECTED', 'DELETED');

-- CreateEnum
CREATE TYPE "ConversionStatus" AS ENUM ('QUEUED', 'RUNNING', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StageStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ArtifactStatus" AS ENUM ('READY', 'DELETED');

-- CreateEnum
CREATE TYPE "SourcePlatform" AS ENUM ('FIGMA', 'FRAMER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ProjectRole" NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateTable
CREATE TABLE "Upload" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "rejection" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversionJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "uploadId" TEXT,
    "createdById" TEXT NOT NULL,
    "sourcePlatform" "SourcePlatform" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "queueJobId" TEXT,
    "status" "ConversionStatus" NOT NULL DEFAULT 'QUEUED',
    "targetProfile" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "cancelRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversionStage" (
    "id" TEXT NOT NULL,
    "conversionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "StageStatus" NOT NULL DEFAULT 'PENDING',
    "inputHash" TEXT,
    "outputKey" TEXT,
    "diagnostics" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ConversionStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleFileVersion" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleFileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversionRuleVersion" (
    "conversionId" TEXT NOT NULL,
    "ruleVersionId" TEXT NOT NULL,

    CONSTRAINT "ConversionRuleVersion_pkey" PRIMARY KEY ("conversionId","ruleVersionId")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "conversionId" TEXT,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValidationReport" (
    "id" TEXT NOT NULL,
    "conversionId" TEXT NOT NULL,
    "diagnostics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectedWordPressSite" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "credentialCiphertext" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "capabilities" JSONB,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedWordPressSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "ProjectMember_userId_projectId_idx" ON "ProjectMember"("userId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Upload_storageKey_key" ON "Upload"("storageKey");

-- CreateIndex
CREATE INDEX "Upload_projectId_createdAt_idx" ON "Upload"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ConversionJob_projectId_createdAt_idx" ON "ConversionJob"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ConversionJob_status_createdAt_idx" ON "ConversionJob"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConversionJob_projectId_idempotencyKey_key" ON "ConversionJob"("projectId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ConversionStage_conversionId_status_idx" ON "ConversionStage"("conversionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ConversionStage_conversionId_name_key" ON "ConversionStage"("conversionId", "name");

-- CreateIndex
CREATE INDEX "RuleFileVersion_fileName_createdAt_idx" ON "RuleFileVersion"("fileName", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RuleFileVersion_fileName_sha256_key" ON "RuleFileVersion"("fileName", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_storageKey_key" ON "Artifact"("storageKey");

-- CreateIndex
CREATE INDEX "Artifact_projectId_createdAt_idx" ON "Artifact"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ValidationReport_conversionId_key" ON "ValidationReport"("conversionId");

-- CreateIndex
CREATE INDEX "ConnectedWordPressSite_projectId_createdAt_idx" ON "ConnectedWordPressSite"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_userId_createdAt_idx" ON "AuditEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_resource_resourceId_idx" ON "AuditEvent"("resource", "resourceId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionJob" ADD CONSTRAINT "ConversionJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionJob" ADD CONSTRAINT "ConversionJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionJob" ADD CONSTRAINT "ConversionJob_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionStage" ADD CONSTRAINT "ConversionStage_conversionId_fkey" FOREIGN KEY ("conversionId") REFERENCES "ConversionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionRuleVersion" ADD CONSTRAINT "ConversionRuleVersion_conversionId_fkey" FOREIGN KEY ("conversionId") REFERENCES "ConversionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionRuleVersion" ADD CONSTRAINT "ConversionRuleVersion_ruleVersionId_fkey" FOREIGN KEY ("ruleVersionId") REFERENCES "RuleFileVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_conversionId_fkey" FOREIGN KEY ("conversionId") REFERENCES "ConversionJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationReport" ADD CONSTRAINT "ValidationReport_conversionId_fkey" FOREIGN KEY ("conversionId") REFERENCES "ConversionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectedWordPressSite" ADD CONSTRAINT "ConnectedWordPressSite_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
