/*
  Warnings:

  - Made the column `incident_id` on table `investigation` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "investigation" ALTER COLUMN "incident_id" SET NOT NULL;
