CREATE TYPE "recurrence_frequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

ALTER TABLE "venues"
    ADD COLUMN "buffer_minutes" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
    ADD CONSTRAINT "venues_valid_buffer_minutes"
        CHECK ("buffer_minutes" BETWEEN 0 AND 1440);

CREATE INDEX "venues_is_active_deleted_at_idx"
    ON "venues" ("is_active", "deleted_at");

CREATE TABLE "venue_availability_hours" (
    "venue_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "opens_at" VARCHAR(5) NOT NULL,
    "closes_at" VARCHAR(5) NOT NULL,
    CONSTRAINT "venue_availability_hours_pkey" PRIMARY KEY ("venue_id", "weekday"),
    CONSTRAINT "venue_availability_hours_valid_weekday"
        CHECK ("weekday" BETWEEN 1 AND 7),
    CONSTRAINT "venue_availability_hours_valid_times"
        CHECK (
            "opens_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND "closes_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND "closes_at" > "opens_at"
        ),
    CONSTRAINT "venue_availability_hours_venue_id_fkey"
        FOREIGN KEY ("venue_id") REFERENCES "venues" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "event_series" (
    "id" UUID NOT NULL,
    "frequency" "recurrence_frequency" NOT NULL,
    "recurrence_interval" INTEGER NOT NULL,
    "occurrence_count" INTEGER,
    "until_date" DATE,
    "exception_dates" DATE[] NOT NULL DEFAULT ARRAY[]::DATE[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "event_series_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "event_series_valid_interval"
        CHECK ("recurrence_interval" BETWEEN 1 AND 12),
    CONSTRAINT "event_series_bounded_end"
        CHECK (
            ("occurrence_count" IS NOT NULL) <> ("until_date" IS NOT NULL)
            AND ("occurrence_count" IS NULL OR "occurrence_count" BETWEEN 1 AND 52)
            AND cardinality("exception_dates") <= 52
        )
);

ALTER TABLE "events"
    ADD COLUMN "expected_attendance" INTEGER,
    ADD COLUMN "venue_id" UUID,
    ADD COLUMN "series_id" UUID,
    ADD COLUMN "occurrence_index" INTEGER,
    ADD CONSTRAINT "events_positive_expected_attendance"
        CHECK ("expected_attendance" IS NULL OR "expected_attendance" BETWEEN 1 AND 100000),
    ADD CONSTRAINT "events_series_occurrence_pair"
        CHECK (("series_id" IS NULL) = ("occurrence_index" IS NULL)),
    ADD CONSTRAINT "events_nonnegative_occurrence_index"
        CHECK ("occurrence_index" IS NULL OR "occurrence_index" BETWEEN 0 AND 51),
    ADD CONSTRAINT "events_venue_id_fkey"
        FOREIGN KEY ("venue_id") REFERENCES "venues" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "events_series_id_fkey"
        FOREIGN KEY ("series_id") REFERENCES "event_series" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "events_series_id_occurrence_index_key"
    ON "events" ("series_id", "occurrence_index");
CREATE INDEX "events_venue_id_start_at_idx"
    ON "events" ("venue_id", "start_at");

