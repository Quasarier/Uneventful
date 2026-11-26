ALTER TABLE "events"
    ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD CONSTRAINT "events_tags_count_check" CHECK (cardinality("tags") <= 20);

CREATE INDEX "events_club_status_start_idx"
    ON "events" ("club_id", "status", "start_at");
CREATE INDEX "rsvps_event_created_status_analytics_idx"
    ON "rsvps" ("event_id", "created_at", "status");
CREATE INDEX "club_memberships_club_status_joined_analytics_idx"
    ON "club_memberships" ("club_id", "status", "joined_at");
CREATE INDEX "check_ins_checked_in_at_idx"
    ON "check_ins" ("checked_in_at");

CREATE TABLE "club_follows" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "club_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "club_follows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "club_follows_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "club_follows_club_id_fkey"
        FOREIGN KEY ("club_id") REFERENCES "clubs" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "club_follows_user_id_club_id_key"
    ON "club_follows" ("user_id", "club_id");
CREATE INDEX "club_follows_club_id_created_at_idx"
    ON "club_follows" ("club_id", "created_at");
CREATE INDEX "club_follows_user_id_created_at_idx"
    ON "club_follows" ("user_id", "created_at");

CREATE TABLE "recommendation_preferences" (
    "user_id" UUID NOT NULL,
    "personalized" BOOLEAN NOT NULL DEFAULT TRUE,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recommendation_preferences_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "recommendation_preferences_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "recommendation_consents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "action" "notification_consent_action" NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recommendation_consents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "recommendation_consents_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "recommendation_consents_user_id_created_at_idx"
    ON "recommendation_consents" ("user_id", "created_at");
