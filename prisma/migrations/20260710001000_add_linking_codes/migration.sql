-- CreateTable: códigos temporales de vinculación Telegram (6 dígitos, 5 min TTL)
CREATE TABLE "LinkingCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "chatId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkingCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkingCode_code_key" ON "LinkingCode"("code");

-- CreateIndex: for expiry cleanup queries
CREATE INDEX "LinkingCode_expiresAt_idx" ON "LinkingCode"("expiresAt");
