-- AlterTable
ALTER TABLE "Subtask" ADD COLUMN     "dispatchedAt" TIMESTAMP(3),
ADD COLUMN     "timeoutAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "approvedAt" TIMESTAMP(3);
