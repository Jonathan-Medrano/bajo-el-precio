-- AlterTable: add lastTracked (nullable) to Product
-- Only the tracker updates this field; null = never tracked by the automated cycle.
ALTER TABLE "Product" ADD COLUMN "lastTracked" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Product_lastTracked_idx" ON "Product"("lastTracked");
