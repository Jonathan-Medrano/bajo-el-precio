-- CreateTable
CREATE TABLE "EmailAlert" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "targetPrice" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailAlert_email_productId_key" ON "EmailAlert"("email", "productId");

-- CreateIndex
CREATE INDEX "EmailAlert_productId_idx" ON "EmailAlert"("productId");

-- AddForeignKey
ALTER TABLE "EmailAlert" ADD CONSTRAINT "EmailAlert_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
