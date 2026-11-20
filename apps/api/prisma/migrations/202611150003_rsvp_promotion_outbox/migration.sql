CREATE TABLE "rsvp_promotion_outbox" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(3),
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "rsvp_promotion_outbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rsvp_promotion_outbox_dispatched_at_created_at_idx"
    ON "rsvp_promotion_outbox"("dispatched_at", "created_at");

ALTER TABLE "rsvp_promotion_outbox"
    ADD CONSTRAINT "rsvp_promotion_outbox_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
