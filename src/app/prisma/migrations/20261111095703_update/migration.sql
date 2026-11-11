-- CreateTable
CREATE TABLE "usage" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "investigation_id" TEXT,
    "model" TEXT NOT NULL,
    "effort" TEXT,
    "status" TEXT NOT NULL,
    "model_calls" INTEGER NOT NULL,
    "uncached_input_tokens" INTEGER NOT NULL,
    "cache_write_tokens" INTEGER NOT NULL,
    "cache_read_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_tenant_id_created_at_idx" ON "usage"("tenant_id", "created_at");
