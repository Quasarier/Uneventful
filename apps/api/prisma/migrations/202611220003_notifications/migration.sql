ALTER TYPE "notification_type" ADD VALUE 'EVENT_UPDATED';
ALTER TYPE "notification_type" ADD VALUE 'RSVP_CANCELLED';
ALTER TYPE "notification_type" ADD VALUE 'EVENT_REMINDER_24H';
ALTER TYPE "notification_type" ADD VALUE 'EVENT_REMINDER_1H';

CREATE TYPE "notification_channel" AS ENUM ('EMAIL', 'PUSH');
CREATE TYPE "notification_delivery_status" AS ENUM (
    'PENDING',
    'PROCESSING',
    'SENT',
    'SKIPPED',
    'DEAD_LETTERED',
    'CANCELLED'
);
CREATE TYPE "notification_consent_action" AS ENUM ('GRANTED', 'OPTED_OUT');

ALTER TABLE "notifications"
    ADD COLUMN "scheduled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "status" "notification_delivery_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_deliveries_nonnegative_attempts" CHECK ("attempts" >= 0),
    CONSTRAINT "notification_deliveries_notification_id_fkey"
        FOREIGN KEY ("notification_id") REFERENCES "notifications" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "notification_deliveries_notification_id_channel_key"
    ON "notification_deliveries" ("notification_id", "channel");
CREATE INDEX "notification_deliveries_status_available_at_idx"
    ON "notification_deliveries" ("status", "available_at");

CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "type" "notification_type" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_preferences_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "notification_preferences_user_id_channel_type_key"
    ON "notification_preferences" ("user_id", "channel", "type");
CREATE INDEX "notification_preferences_user_id_channel_idx"
    ON "notification_preferences" ("user_id", "channel");

CREATE TABLE "notification_consents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "type" "notification_type" NOT NULL,
    "action" "notification_consent_action" NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_consents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_consents_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "notification_consents_user_id_channel_type_created_at_idx"
    ON "notification_consents" ("user_id", "channel", "type", "created_at");

CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" VARCHAR(2048) NOT NULL,
    "p256dh" VARCHAR(128) NOT NULL,
    "auth" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "push_subscriptions_nonempty_keys"
        CHECK (length("p256dh") BETWEEN 1 AND 128 AND length("auth") BETWEEN 1 AND 128),
    CONSTRAINT "push_subscriptions_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions" ("endpoint");
CREATE INDEX "push_subscriptions_user_id_created_at_idx"
    ON "push_subscriptions" ("user_id", "created_at");
