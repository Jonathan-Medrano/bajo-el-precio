-- Add lastNotifiedPrice to EmailAlert for anti-spam (mirrors Alert.lastNotifiedPrice)
ALTER TABLE "EmailAlert" ADD COLUMN "lastNotifiedPrice" INTEGER;
