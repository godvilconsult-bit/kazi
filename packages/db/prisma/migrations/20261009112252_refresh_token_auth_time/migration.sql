/*
  Warnings:

  - Added the required column `authTime` to the `RefreshToken` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "authTime" TIMESTAMP(3) NOT NULL;
