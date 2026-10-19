-- CreateEnum
CREATE TYPE "InvestigationStatus" AS ENUM ('running', 'done', 'failed');

-- CreateTable
CREATE TABLE "investigation" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "cluster" TEXT NOT NULL,
    "incident_id" TEXT,
    "model" TEXT NOT NULL,
    "system_prompt" TEXT NOT NULL,
    "status" "InvestigationStatus" NOT NULL DEFAULT 'running',
    "report" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "investigation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "investigation_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("investigation_id","seq")
);

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_investigation_id_fkey" FOREIGN KEY ("investigation_id") REFERENCES "investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
