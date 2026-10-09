-- CreateEnum
CREATE TYPE "SubtaskKind" AS ENUM ('WORK', 'SERVICE_FEE');

-- AlterTable
ALTER TABLE "Subtask" ADD COLUMN     "kind" "SubtaskKind" NOT NULL DEFAULT 'WORK';
