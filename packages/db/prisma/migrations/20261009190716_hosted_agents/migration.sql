-- CreateEnum
CREATE TYPE "ProviderHosting" AS ENUM ('SELF', 'KAZI');

-- CreateEnum
CREATE TYPE "TaskSpeed" AS ENUM ('ECONOMY', 'EXPRESS');

-- CreateEnum
CREATE TYPE "HostedRunMode" AS ENUM ('STANDARD', 'BATCH');

-- CreateEnum
CREATE TYPE "HostedRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "Provider" ADD COLUMN     "aiCost" JSONB,
ADD COLUMN     "hostedAdvice" JSONB,
ADD COLUMN     "hostedConfig" JSONB,
ADD COLUMN     "hosting" "ProviderHosting" NOT NULL DEFAULT 'SELF';

-- AlterTable
ALTER TABLE "Subtask" ADD COLUMN     "aiCost" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "speed" "TaskSpeed" NOT NULL DEFAULT 'ECONOMY';

-- CreateTable
CREATE TABLE "HostedRun" (
    "id" TEXT NOT NULL,
    "subtaskId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "mode" "HostedRunMode" NOT NULL,
    "status" "HostedRunStatus" NOT NULL DEFAULT 'RUNNING',
    "batchId" TEXT,
    "turns" JSONB NOT NULL DEFAULT '[]',
    "partial" TEXT NOT NULL DEFAULT '',
    "usage" JSONB,
    "costNano" TEXT NOT NULL DEFAULT '0',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "HostedRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HostedRun_status_mode_idx" ON "HostedRun"("status", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "HostedRun_subtaskId_attempt_key" ON "HostedRun"("subtaskId", "attempt");

-- AddForeignKey
ALTER TABLE "HostedRun" ADD CONSTRAINT "HostedRun_subtaskId_fkey" FOREIGN KEY ("subtaskId") REFERENCES "Subtask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
