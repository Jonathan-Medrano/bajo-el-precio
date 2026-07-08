-- CreateTable
CREATE TABLE "Alert" (
    "id" SERIAL NOT NULL,
    "chatId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "targetPrice" INTEGER,
    "lastNotifiedPrice" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Alert_productId_idx" ON "Alert"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_chatId_productId_key" ON "Alert"("chatId", "productId");

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
