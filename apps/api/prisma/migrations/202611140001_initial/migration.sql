-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('STUDENT', 'ORGANIZER', 'ADMIN');

-- CreateEnum
CREATE TYPE "club_membership_role" AS ENUM ('MEMBER', 'OFFICER', 'PRESIDENT');

-- CreateEnum
CREATE TYPE "club_membership_status" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'LEFT');

-- CreateEnum
CREATE TYPE "event_status" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "venue_booking_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "rsvp_status" AS ENUM ('GOING', 'WAITLISTED', 'CANCELLED', 'CHECKED_IN');

-- CreateEnum
CREATE TYPE "ticket_status" AS ENUM ('ISSUED', 'REVOKED', 'REDEEMED');

-- CreateEnum
CREATE TYPE "check_in_method" AS ENUM ('QR', 'MANUAL');

-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('EVENT_SUBMITTED', 'EVENT_APPROVED', 'EVENT_REJECTED', 'EVENT_CANCELLED', 'RSVP_CONFIRMED', 'WAITLISTED', 'EVENT_REMINDER', 'VENUE_BOOKING_UPDATED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "google_subject" VARCHAR(255) NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "avatar_url" VARCHAR(2048),
    "role" "user_role" NOT NULL DEFAULT 'STUDENT',
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clubs" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "slug" VARCHAR(180) NOT NULL,
    "description" TEXT,
    "created_by_id" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clubs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_memberships" (
    "id" UUID NOT NULL,
    "club_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "club_membership_role" NOT NULL DEFAULT 'MEMBER',
    "status" "club_membership_status" NOT NULL DEFAULT 'PENDING',
    "joined_at" TIMESTAMPTZ(3),
    "left_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_categories" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venues" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "slug" VARCHAR(180) NOT NULL,
    "building" VARCHAR(160),
    "room" VARCHAR(80),
    "capacity" INTEGER NOT NULL,
    "is_accessible" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(220) NOT NULL,
    "description" TEXT NOT NULL,
    "status" "event_status" NOT NULL DEFAULT 'DRAFT',
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "time_zone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "capacity" INTEGER,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "club_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_bookings" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "reviewed_by_id" UUID,
    "status" "venue_booking_status" NOT NULL DEFAULT 'PENDING',
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rsvps" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "rsvp_status" NOT NULL DEFAULT 'GOING',
    "waitlist_position" INTEGER,
    "checked_in_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rsvps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "rsvp_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "status" "ticket_status" NOT NULL DEFAULT 'ISSUED',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_ins" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "checked_in_by_id" UUID NOT NULL,
    "method" "check_in_method" NOT NULL,
    "checked_in_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "event_id" UUID,
    "dedupe_key" VARCHAR(180),
    "type" "notification_type" NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(128) NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "entity_id" UUID,
    "request_id" VARCHAR(128),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "replaced_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_subject_key" ON "users"("google_subject");

-- CreateIndex
CREATE INDEX "users_role_is_active_idx" ON "users"("role", "is_active");

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "clubs_slug_active_key" ON "clubs"("slug")
    WHERE "deleted_at" IS NULL;

-- CreateIndex
CREATE INDEX "clubs_created_by_id_idx" ON "clubs"("created_by_id");

-- CreateIndex
CREATE INDEX "clubs_deleted_at_idx" ON "clubs"("deleted_at");

-- CreateIndex
CREATE INDEX "club_memberships_user_id_status_idx" ON "club_memberships"("user_id", "status");

-- CreateIndex
CREATE INDEX "club_memberships_club_id_status_idx" ON "club_memberships"("club_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "club_memberships_club_id_user_id_key" ON "club_memberships"("club_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_categories_name_active_key" ON "event_categories"("name")
    WHERE "deleted_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "event_categories_slug_active_key" ON "event_categories"("slug")
    WHERE "deleted_at" IS NULL;

-- CreateIndex
CREATE INDEX "event_categories_deleted_at_idx" ON "event_categories"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "venues_slug_active_key" ON "venues"("slug")
    WHERE "deleted_at" IS NULL;

-- CreateIndex
CREATE INDEX "venues_deleted_at_idx" ON "venues"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "events_slug_active_key" ON "events"("slug")
    WHERE "deleted_at" IS NULL;

-- CreateIndex
CREATE INDEX "events_start_at_idx" ON "events"("start_at");

-- CreateIndex
CREATE INDEX "events_status_start_at_idx" ON "events"("status", "start_at");

-- CreateIndex
CREATE INDEX "events_club_id_start_at_idx" ON "events"("club_id", "start_at");

-- CreateIndex
CREATE INDEX "events_category_id_start_at_idx" ON "events"("category_id", "start_at");

-- CreateIndex
CREATE INDEX "events_created_by_id_created_at_idx" ON "events"("created_by_id", "created_at");

-- CreateIndex
CREATE INDEX "events_deleted_at_idx" ON "events"("deleted_at");

-- CreateIndex
CREATE INDEX "venue_bookings_event_id_status_idx" ON "venue_bookings"("event_id", "status");

-- CreateIndex
CREATE INDEX "venue_bookings_venue_id_start_at_end_at_idx" ON "venue_bookings"("venue_id", "start_at", "end_at");

-- CreateIndex
CREATE INDEX "venue_bookings_requested_by_id_created_at_idx" ON "venue_bookings"("requested_by_id", "created_at");

-- CreateIndex
CREATE INDEX "rsvps_event_id_status_created_at_idx" ON "rsvps"("event_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "rsvps_user_id_status_created_at_idx" ON "rsvps"("user_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "rsvps_event_id_user_id_key" ON "rsvps"("event_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_rsvp_id_key" ON "tickets"("rsvp_id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_token_hash_key" ON "tickets"("token_hash");

-- CreateIndex
CREATE INDEX "tickets_status_expires_at_idx" ON "tickets"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "check_ins_ticket_id_key" ON "check_ins"("ticket_id");

-- CreateIndex
CREATE INDEX "check_ins_checked_in_by_id_checked_in_at_idx" ON "check_ins"("checked_in_by_id", "checked_in_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_active_key" ON "notifications"("dedupe_key")
    WHERE "deleted_at" IS NULL;

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notifications_event_id_created_at_idx" ON "notifications"("event_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_deleted_at_idx" ON "notifications"("deleted_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_request_id_idx" ON "audit_logs"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replaced_by_id_key" ON "refresh_tokens"("replaced_by_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_family_id_expires_at_idx" ON "refresh_tokens"("user_id", "family_id", "expires_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_revoked_at_idx" ON "refresh_tokens"("user_id", "revoked_at");

-- AddForeignKey
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "event_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_bookings" ADD CONSTRAINT "venue_bookings_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_bookings" ADD CONSTRAINT "venue_bookings_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_bookings" ADD CONSTRAINT "venue_bookings_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_bookings" ADD CONSTRAINT "venue_bookings_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_rsvp_id_fkey" FOREIGN KEY ("rsvp_id") REFERENCES "rsvps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_checked_in_by_id_fkey" FOREIGN KEY ("checked_in_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PostgreSQL needs btree_gist to combine UUID equality with a range overlap
-- operator in the venue-booking exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "events"
    ADD CONSTRAINT "events_valid_time_range"
        CHECK ("end_at" > "start_at"),
    ADD CONSTRAINT "events_positive_capacity"
        CHECK ("capacity" IS NULL OR "capacity" > 0),
    ADD CONSTRAINT "events_approved_has_reviewer"
        CHECK ("status" <> 'APPROVED' OR ("approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL));

ALTER TABLE "users"
    ADD CONSTRAINT "users_non_negative_token_version"
        CHECK ("token_version" >= 0);

ALTER TABLE "venues"
    ADD CONSTRAINT "venues_positive_capacity"
        CHECK ("capacity" > 0);

ALTER TABLE "venue_bookings"
    ADD CONSTRAINT "venue_bookings_valid_time_range"
        CHECK ("end_at" > "start_at"),
    ADD CONSTRAINT "venue_bookings_reviewed_has_reviewer"
        CHECK (
            "status" NOT IN ('APPROVED', 'REJECTED')
            OR ("reviewed_by_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
        );

ALTER TABLE "rsvps"
    ADD CONSTRAINT "rsvps_valid_waitlist_position"
        CHECK (
            ("status" = 'WAITLISTED' AND "waitlist_position" IS NOT NULL AND "waitlist_position" > 0)
            OR ("status" <> 'WAITLISTED' AND "waitlist_position" IS NULL)
        ),
    ADD CONSTRAINT "rsvps_checked_in_has_timestamp"
        CHECK ("status" <> 'CHECKED_IN' OR "checked_in_at" IS NOT NULL);

ALTER TABLE "tickets"
    ADD CONSTRAINT "tickets_valid_expiration"
        CHECK ("expires_at" > "created_at"),
    ADD CONSTRAINT "tickets_token_hash_is_hex"
        CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "refresh_tokens"
    ADD CONSTRAINT "refresh_tokens_valid_expiration"
        CHECK ("expires_at" > "created_at"),
    ADD CONSTRAINT "refresh_tokens_non_negative_token_version"
        CHECK ("token_version" >= 0),
    ADD CONSTRAINT "refresh_tokens_token_hash_is_hex"
        CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

CREATE FUNCTION public.bump_user_token_version_on_role_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        NEW.token_version := OLD.token_version + 1;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "users_bump_token_version_on_role_change"
    BEFORE UPDATE OF "role" ON "users"
    FOR EACH ROW
    EXECUTE FUNCTION public.bump_user_token_version_on_role_change();

CREATE FUNCTION public.revoke_user_refresh_tokens_on_role_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        UPDATE "refresh_tokens"
        SET "revoked_at" = CURRENT_TIMESTAMP,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "user_id" = NEW.id
          AND "revoked_at" IS NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "users_revoke_refresh_tokens_on_role_change"
    AFTER UPDATE OF "role" ON "users"
    FOR EACH ROW
    EXECUTE FUNCTION public.revoke_user_refresh_tokens_on_role_change();

CREATE UNIQUE INDEX "venue_bookings_one_approved_per_event_idx"
    ON "venue_bookings" ("event_id")
    WHERE "status" = 'APPROVED';

ALTER TABLE "venue_bookings"
    ADD CONSTRAINT "venue_bookings_no_overlapping_approved"
    EXCLUDE USING gist (
        "venue_id" WITH =,
        tstzrange("start_at", "end_at", '[)') WITH &&
    )
    WHERE ("status" = 'APPROVED');

CREATE FUNCTION public.prevent_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs are append-only'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "audit_logs_append_only"
    BEFORE UPDATE OR DELETE ON "audit_logs"
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_audit_log_mutation();

CREATE TRIGGER "audit_logs_prevent_truncate"
    BEFORE TRUNCATE ON "audit_logs"
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.prevent_audit_log_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "audit_logs" FROM uneventful_app;
