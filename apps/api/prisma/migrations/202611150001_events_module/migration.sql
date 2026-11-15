ALTER TABLE "events"
    ADD COLUMN "image_key" VARCHAR(512),
    ADD COLUMN "pending_image_key" VARCHAR(512),
    ADD COLUMN "pending_image_expires_at" TIMESTAMPTZ(3),
    ADD COLUMN "rejection_reason" VARCHAR(1000);
