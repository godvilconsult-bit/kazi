-- AlterTable
ALTER TABLE "ChainEvent" ADD COLUMN     "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "ChainEvent_contract_name_indexedAt_idx" ON "ChainEvent"("contract", "name", "indexedAt");
