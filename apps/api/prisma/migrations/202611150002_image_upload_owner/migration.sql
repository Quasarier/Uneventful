ALTER TABLE "events"
    ADD COLUMN "pending_image_owner_id" UUID,
    ADD CONSTRAINT "events_pending_image_upload_complete"
        CHECK (
            ("pending_image_key" IS NULL AND "pending_image_owner_id" IS NULL AND "pending_image_expires_at" IS NULL)
            OR
            ("pending_image_key" IS NOT NULL AND "pending_image_owner_id" IS NOT NULL AND "pending_image_expires_at" IS NOT NULL)
        ),
    ADD CONSTRAINT "events_pending_image_owner_id_fkey"
        FOREIGN KEY ("pending_image_owner_id") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
