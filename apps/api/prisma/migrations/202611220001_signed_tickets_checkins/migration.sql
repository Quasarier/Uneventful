ALTER TYPE "ticket_status" RENAME VALUE 'REDEEMED' TO 'USED';

ALTER TABLE "tickets" RENAME COLUMN "token_hash" TO "ticket_id_hash";
ALTER INDEX "tickets_token_hash_key" RENAME TO "tickets_ticket_id_hash_key";

UPDATE "tickets"
SET "status" = 'REVOKED',
    "revoked_at" = COALESCE("revoked_at", CURRENT_TIMESTAMP)
WHERE "status" = 'ISSUED';

ALTER TABLE "check_ins"
ADD COLUMN "device_id" UUID,
ADD COLUMN "scanned_at" TIMESTAMPTZ(3);
