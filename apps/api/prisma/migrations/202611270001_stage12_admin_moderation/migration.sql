ALTER TYPE "notification_type" ADD VALUE 'ACCOUNT_ROLE_CHANGED';
ALTER TYPE "notification_type" ADD VALUE 'ACCOUNT_SUSPENDED';
ALTER TYPE "notification_type" ADD VALUE 'ACCOUNT_REACTIVATED';

CREATE TYPE "club_verification_status" AS ENUM ('UNVERIFIED', 'VERIFIED', 'SUSPENDED');
CREATE TYPE "moderation_target_type" AS ENUM ('EVENT', 'CLUB');
CREATE TYPE "moderation_report_reason" AS ENUM ('SPAM', 'HARASSMENT', 'UNSAFE', 'MISLEADING', 'OTHER');
CREATE TYPE "moderation_report_status" AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE "moderation_action" AS ENUM ('DISMISS', 'HIDE_EVENT', 'CANCEL_EVENT', 'SUSPEND_CLUB');
CREATE TYPE "admin_role_grant_status" AS ENUM ('PENDING', 'APPROVED', 'EXPIRED');

ALTER TABLE "clubs"
  ADD COLUMN "verification_status" "club_verification_status" NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN "verification_reason" VARCHAR(1000),
  ADD COLUMN "suspended_at" TIMESTAMPTZ(3);

ALTER TABLE "audit_logs"
  ADD COLUMN "reason" VARCHAR(1000),
  ADD COLUMN "before_values" JSONB,
  ADD COLUMN "after_values" JSONB,
  ADD COLUMN "actor_ip" VARCHAR(45);

CREATE TABLE "moderation_reports" (
  "id" UUID NOT NULL,
  "reporter_id" UUID NOT NULL,
  "target_type" "moderation_target_type" NOT NULL,
  "target_id" UUID NOT NULL,
  "open_key" VARCHAR(240),
  "reason" "moderation_report_reason" NOT NULL,
  "note" VARCHAR(1000),
  "status" "moderation_report_status" NOT NULL DEFAULT 'OPEN',
  "resolution_action" "moderation_action",
  "resolution_reason" VARCHAR(1000),
  "resolved_by_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(3),
  CONSTRAINT "moderation_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "moderation_reports_note_length" CHECK ("note" IS NULL OR char_length("note") <= 1000),
  CONSTRAINT "moderation_reports_resolution_reason_length" CHECK ("resolution_reason" IS NULL OR char_length("resolution_reason") <= 1000),
  CONSTRAINT "moderation_reports_open_key_state" CHECK (
    ("status" = 'OPEN' AND "open_key" IS NOT NULL AND "resolution_action" IS NULL AND "resolved_at" IS NULL)
    OR ("status" = 'RESOLVED' AND "open_key" IS NULL AND "resolution_action" IS NOT NULL AND "resolved_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "moderation_reports_open_key_key" ON "moderation_reports"("open_key");
CREATE INDEX "moderation_reports_status_created_at_id_idx" ON "moderation_reports"("status", "created_at", "id");
CREATE INDEX "moderation_reports_target_type_target_id_status_idx" ON "moderation_reports"("target_type", "target_id", "status");

CREATE TABLE "admin_role_grant_requests" (
  "id" UUID NOT NULL,
  "target_user_id" UUID NOT NULL,
  "requested_by_id" UUID NOT NULL,
  "approved_by_id" UUID,
  "status" "admin_role_grant_status" NOT NULL DEFAULT 'PENDING',
  "reason" VARCHAR(1000) NOT NULL,
  "approval_reason" VARCHAR(1000),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(3),
  CONSTRAINT "admin_role_grant_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_role_grant_requests_reason_length" CHECK (char_length("reason") BETWEEN 1 AND 1000),
  CONSTRAINT "admin_role_grant_requests_approval_reason_length" CHECK ("approval_reason" IS NULL OR char_length("approval_reason") BETWEEN 1 AND 1000),
  CONSTRAINT "admin_role_grant_requests_approval_state" CHECK (
    ("status" = 'PENDING' AND "approved_by_id" IS NULL AND "resolved_at" IS NULL)
    OR ("status" = 'APPROVED' AND "approved_by_id" IS NOT NULL AND "resolved_at" IS NOT NULL)
    OR ("status" = 'EXPIRED' AND "approved_by_id" IS NULL AND "resolved_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "admin_role_grant_requests_one_pending_per_target"
  ON "admin_role_grant_requests"("target_user_id")
  WHERE "status" = 'PENDING';
CREATE INDEX "admin_role_grant_requests_status_expires_at_idx"
  ON "admin_role_grant_requests"("status", "expires_at");
CREATE INDEX "admin_role_grant_requests_target_user_id_created_at_idx"
  ON "admin_role_grant_requests"("target_user_id", "created_at");

ALTER TABLE "moderation_reports"
  ADD CONSTRAINT "moderation_reports_reporter_id_fkey"
  FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "moderation_reports_resolved_by_id_fkey"
  FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "admin_role_grant_requests"
  ADD CONSTRAINT "admin_role_grant_requests_target_user_id_fkey"
  FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "admin_role_grant_requests_requested_by_id_fkey"
  FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "admin_role_grant_requests_approved_by_id_fkey"
  FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
