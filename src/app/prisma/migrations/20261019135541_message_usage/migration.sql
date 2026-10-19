-- AlterTable
ALTER TABLE "message" ADD COLUMN     "cache_read_tokens" INTEGER,
ADD COLUMN     "cache_write_tokens" INTEGER,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "output_tokens" INTEGER,
ADD COLUMN     "uncached_input_tokens" INTEGER;
