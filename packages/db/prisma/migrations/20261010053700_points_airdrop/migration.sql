-- CreateEnum
CREATE TYPE "PointsRole" AS ENUM ('CLIENT', 'PROVIDER');

-- CreateTable
CREATE TABLE "PointsEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "role" "PointsRole" NOT NULL,
    "feeUnits" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "flag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PointsEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AirdropAllocation" (
    "id" TEXT NOT NULL,
    "airdropId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "proof" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AirdropAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PointsEntry_userId_idx" ON "PointsEntry"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PointsEntry_userId_taskId_role_key" ON "PointsEntry"("userId", "taskId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "AirdropAllocation_airdropId_wallet_key" ON "AirdropAllocation"("airdropId", "wallet");

-- AddForeignKey
ALTER TABLE "PointsEntry" ADD CONSTRAINT "PointsEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
