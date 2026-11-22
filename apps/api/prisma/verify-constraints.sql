BEGIN;

DO $$
DECLARE
    admin_id UUID := gen_random_uuid();
    organizer_id UUID := gen_random_uuid();
    student_id UUID := gen_random_uuid();
    club_id UUID := gen_random_uuid();
    category_id UUID := gen_random_uuid();
    venue_id UUID := gen_random_uuid();
    event_one_id UUID := gen_random_uuid();
    event_two_id UUID := gen_random_uuid();
    event_three_id UUID := gen_random_uuid();
    event_cancelled_id UUID := gen_random_uuid();
    event_rejected_id UUID := gen_random_uuid();
    deleted_event_id UUID := gen_random_uuid();
    deleted_event_replacement_id UUID := gen_random_uuid();
    rsvp_id UUID := gen_random_uuid();
    duplicate_rsvp_id UUID := gen_random_uuid();
    audit_id UUID := gen_random_uuid();
    series_id UUID := gen_random_uuid();
    v_start_at TIMESTAMPTZ := '2035-02-01 10:00:00+00';
    ticket_status_values TEXT[];
BEGIN
    IF current_user <> 'uneventful_app' THEN
        RAISE EXCEPTION 'Constraint checks must run as uneventful_app, not %.', current_user;
    END IF;
    IF has_table_privilege(current_user, 'public._prisma_migrations', 'SELECT')
       OR has_table_privilege(current_user, 'public._prisma_migrations', 'INSERT')
       OR has_table_privilege(current_user, 'public._prisma_migrations', 'UPDATE')
       OR has_table_privilege(current_user, 'public._prisma_migrations', 'DELETE') THEN
        RAISE EXCEPTION 'Application role must not access Prisma migration metadata.';
    END IF;

    INSERT INTO users (id, email, google_subject, first_name, last_name, role)
    VALUES
        (admin_id, 'constraint-admin@example.edu', 'constraint-admin', 'Test', 'Admin', 'ADMIN'),
        (organizer_id, 'constraint-organizer@example.edu', 'constraint-organizer', 'Test', 'Organizer', 'ORGANIZER'),
        (student_id, 'constraint-student@example.edu', 'constraint-student', 'Test', 'Student', 'STUDENT');

    INSERT INTO clubs (id, name, slug, created_by_id)
    VALUES (club_id, 'Constraint Test Club', 'constraint-test-club', organizer_id);

    INSERT INTO event_categories (id, name, slug)
    VALUES (category_id, 'Constraint Tests', 'constraint-tests');

    INSERT INTO venues (id, name, slug, capacity)
    VALUES (venue_id, 'Constraint Test Venue', 'constraint-test-venue', 100);

    BEGIN
        UPDATE venues SET buffer_minutes = 1441 WHERE id = venue_id;
        RAISE EXCEPTION 'Expected an invalid venue buffer to be rejected.';
    EXCEPTION
        WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO venue_availability_hours (venue_id, weekday, opens_at, closes_at)
        VALUES (venue_id, 1, '09:00', '09:00');
        RAISE EXCEPTION 'Expected an invalid venue availability window to be rejected.';
    EXCEPTION
        WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO events (
            id, title, slug, description, start_at, end_at, expected_attendance,
            club_id, category_id, created_by_id
        )
        VALUES (
            gen_random_uuid(), 'Invalid Expected Attendance', 'constraint-invalid-attendance',
            'Test fixture.', v_start_at, v_start_at + INTERVAL '1 hour', 0,
            club_id, category_id, organizer_id
        );
        RAISE EXCEPTION 'Expected non-positive expected attendance to be rejected.';
    EXCEPTION
        WHEN check_violation THEN NULL;
    END;

    INSERT INTO event_series (
        id, frequency, recurrence_interval, occurrence_count
    )
    VALUES (series_id, 'WEEKLY', 1, 1);

    BEGIN
        INSERT INTO event_series (
            id, frequency, recurrence_interval, occurrence_count
        )
        VALUES (gen_random_uuid(), 'WEEKLY', 1, 53);
        RAISE EXCEPTION 'Expected an over-cap event series to be rejected.';
    EXCEPTION
        WHEN check_violation THEN NULL;
    END;

    INSERT INTO events (
        id, title, slug, description, status, start_at, end_at, capacity,
        club_id, category_id, created_by_id, approved_by_id, approved_at
    )
    VALUES
        (event_one_id, 'First Constraint Event', 'constraint-event-one', 'Test fixture.', 'APPROVED',
         v_start_at, v_start_at + INTERVAL '1 hour', 50, club_id, category_id, organizer_id, admin_id, NOW()),
        (event_two_id, 'Adjacent Constraint Event', 'constraint-event-two', 'Test fixture.', 'APPROVED',
         v_start_at + INTERVAL '1 hour', v_start_at + INTERVAL '2 hours', 50,
         club_id, category_id, organizer_id, admin_id, NOW()),
        (event_three_id, 'Overlapping Constraint Event', 'constraint-event-three', 'Test fixture.', 'APPROVED',
         v_start_at + INTERVAL '30 minutes', v_start_at + INTERVAL '90 minutes', 50,
         club_id, category_id, organizer_id, admin_id, NOW()),
        (event_cancelled_id, 'Cancelled Booking Retry', 'constraint-event-cancelled', 'Test fixture.', 'APPROVED',
         v_start_at + INTERVAL '2 hours', v_start_at + INTERVAL '3 hours', 50,
         club_id, category_id, organizer_id, admin_id, NOW()),
        (event_rejected_id, 'Rejected Booking Retry', 'constraint-event-rejected', 'Test fixture.', 'APPROVED',
         v_start_at + INTERVAL '3 hours', v_start_at + INTERVAL '4 hours', 50,
         club_id, category_id, organizer_id, admin_id, NOW());

    INSERT INTO venue_bookings (
        id, event_id, venue_id, requested_by_id, reviewed_by_id, status,
        start_at, end_at, reviewed_at
    )
    VALUES
        (gen_random_uuid(), event_one_id, venue_id, organizer_id, admin_id, 'APPROVED',
         v_start_at, v_start_at + INTERVAL '1 hour', NOW()),
        (gen_random_uuid(), event_two_id, venue_id, organizer_id, admin_id, 'APPROVED',
         v_start_at + INTERVAL '1 hour', v_start_at + INTERVAL '2 hours', NOW());

    BEGIN
        INSERT INTO venue_bookings (
            id, event_id, venue_id, requested_by_id, reviewed_by_id, status,
            start_at, end_at, reviewed_at
        )
        VALUES (
            gen_random_uuid(), event_three_id, venue_id, organizer_id, admin_id, 'APPROVED',
            v_start_at + INTERVAL '30 minutes', v_start_at + INTERVAL '90 minutes', NOW()
        );
        RAISE EXCEPTION 'Expected overlapping approved venue booking to be rejected.';
    EXCEPTION
        WHEN exclusion_violation THEN NULL;
    END;

    INSERT INTO venue_bookings (
        id, event_id, venue_id, requested_by_id, status, start_at, end_at
    )
    VALUES (
        gen_random_uuid(), event_cancelled_id, venue_id, organizer_id, 'CANCELLED',
        v_start_at + INTERVAL '2 hours', v_start_at + INTERVAL '3 hours'
    );
    INSERT INTO venue_bookings (
        id, event_id, venue_id, requested_by_id, reviewed_by_id, status,
        start_at, end_at, reviewed_at
    )
    VALUES (
        gen_random_uuid(), event_cancelled_id, venue_id, organizer_id, admin_id, 'APPROVED',
        v_start_at + INTERVAL '2 hours', v_start_at + INTERVAL '3 hours', NOW()
    );

    INSERT INTO venue_bookings (
        id, event_id, venue_id, requested_by_id, reviewed_by_id, status,
        start_at, end_at, reviewed_at
    )
    VALUES (
        gen_random_uuid(), event_rejected_id, venue_id, organizer_id, admin_id, 'REJECTED',
        v_start_at + INTERVAL '3 hours', v_start_at + INTERVAL '4 hours', NOW()
    );
    INSERT INTO venue_bookings (
        id, event_id, venue_id, requested_by_id, reviewed_by_id, status,
        start_at, end_at, reviewed_at
    )
    VALUES (
        gen_random_uuid(), event_rejected_id, venue_id, organizer_id, admin_id, 'APPROVED',
        v_start_at + INTERVAL '3 hours', v_start_at + INTERVAL '4 hours', NOW()
    );

    INSERT INTO rsvps (id, event_id, user_id, status)
    VALUES (rsvp_id, event_one_id, student_id, 'GOING');
    INSERT INTO rsvps (id, event_id, user_id, status)
    VALUES (duplicate_rsvp_id, event_two_id, student_id, 'GOING');

    BEGIN
        INSERT INTO rsvps (id, event_id, user_id, status)
        VALUES (gen_random_uuid(), event_one_id, student_id, 'GOING');
        RAISE EXCEPTION 'Expected duplicate event RSVP to be rejected.';
    EXCEPTION
        WHEN unique_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO events (
            id, title, slug, description, start_at, end_at, club_id, category_id, created_by_id
        )
        VALUES (
            gen_random_uuid(), 'Invalid Event Range', 'constraint-invalid-event-range', 'Test fixture.',
            v_start_at, v_start_at, club_id, category_id, organizer_id
        );
        RAISE EXCEPTION 'Expected an event with end_at <= start_at to be rejected.';
    EXCEPTION
        WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO events (
            id, title, slug, description, start_at, end_at, capacity, club_id, category_id, created_by_id
        )
        VALUES (
            gen_random_uuid(), 'Invalid Event Capacity', 'constraint-invalid-event-capacity', 'Test fixture.',
            v_start_at, v_start_at + INTERVAL '1 hour', 0, club_id, category_id, organizer_id
        );
        RAISE EXCEPTION 'Expected event capacity <= 0 to be rejected.';
    EXCEPTION
        WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO venues (id, name, slug, capacity)
        VALUES (gen_random_uuid(), 'Invalid Capacity Venue', 'constraint-invalid-venue-capacity', 0);
        RAISE EXCEPTION 'Expected venue capacity <= 0 to be rejected.';
    EXCEPTION
        WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO venue_bookings (
            id, event_id, venue_id, requested_by_id, status, start_at, end_at
        )
        VALUES (
            gen_random_uuid(), event_one_id, venue_id, organizer_id, 'PENDING', v_start_at, v_start_at
        );
        RAISE EXCEPTION 'Expected a booking with end_at <= start_at to be rejected.';
    EXCEPTION
        WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO rsvps (id, event_id, user_id, status, waitlist_position)
        VALUES (gen_random_uuid(), event_two_id, student_id, 'WAITLISTED', 0);
        RAISE EXCEPTION 'Expected a non-positive waitlist position to be rejected.';
    EXCEPTION
        WHEN check_violation THEN NULL;
    END;

    SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
    INTO ticket_status_values
    FROM pg_enum AS e
    JOIN pg_type AS t ON t.oid = e.enumtypid
    JOIN pg_namespace AS n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'ticket_status';

    IF ticket_status_values IS DISTINCT FROM ARRAY['ISSUED', 'REVOKED', 'USED']::TEXT[] THEN
        RAISE EXCEPTION 'Unexpected ticket_status values: %.', ticket_status_values;
    END IF;

    INSERT INTO tickets (id, rsvp_id, ticket_id_hash, expires_at, created_at)
    VALUES (
        gen_random_uuid(), rsvp_id, repeat('a', 64),
        v_start_at + INTERVAL '1 hour', v_start_at
    );

    BEGIN
        INSERT INTO tickets (id, rsvp_id, ticket_id_hash, expires_at, created_at)
        VALUES (
            gen_random_uuid(), duplicate_rsvp_id, repeat('a', 64),
            v_start_at + INTERVAL '1 hour', v_start_at
        );
        RAISE EXCEPTION 'Expected a duplicate ticket ID hash to be rejected.';
    EXCEPTION
        WHEN unique_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO tickets (id, rsvp_id, ticket_id_hash, status, expires_at, created_at)
        VALUES (
            gen_random_uuid(), duplicate_rsvp_id, repeat('c', 64), 'INVALID',
            v_start_at + INTERVAL '1 hour', v_start_at
        );
        RAISE EXCEPTION 'Expected an invalid ticket status to be rejected.';
    EXCEPTION
        WHEN invalid_text_representation THEN NULL;
    END;

    BEGIN
        INSERT INTO tickets (id, rsvp_id, ticket_id_hash, expires_at, created_at)
        VALUES (gen_random_uuid(), duplicate_rsvp_id, repeat('d', 64), v_start_at, v_start_at);
        RAISE EXCEPTION 'Expected a ticket that expires at creation time to be rejected.';
    EXCEPTION
        WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, created_at)
        VALUES (
            gen_random_uuid(), student_id, gen_random_uuid(), repeat('b', 64), v_start_at, v_start_at
        );
        RAISE EXCEPTION 'Expected a refresh token that expires at creation time to be rejected.';
    EXCEPTION
        WHEN check_violation THEN NULL;
    END;

    INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id)
    VALUES (audit_id, admin_id, 'constraint-test', 'event', event_one_id);

    BEGIN
        UPDATE audit_logs SET action = 'tampered' WHERE id = audit_id;
        RAISE EXCEPTION 'Expected application-role audit-log UPDATE to be rejected.';
    EXCEPTION
        WHEN insufficient_privilege OR integrity_constraint_violation THEN NULL;
    END;

    BEGIN
        DELETE FROM audit_logs WHERE id = audit_id;
        RAISE EXCEPTION 'Expected application-role audit-log DELETE to be rejected.';
    EXCEPTION
        WHEN insufficient_privilege OR integrity_constraint_violation THEN NULL;
    END;

    BEGIN
        TRUNCATE audit_logs;
        RAISE EXCEPTION 'Expected application-role audit-log TRUNCATE to be rejected.';
    EXCEPTION
        WHEN insufficient_privilege OR integrity_constraint_violation THEN NULL;
    END;

    BEGIN
        ALTER TABLE audit_logs ADD COLUMN app_role_ddl_probe INTEGER;
        RAISE EXCEPTION 'Expected application-role ALTER TABLE to be rejected.';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
        ALTER TABLE tickets ADD COLUMN app_role_ddl_probe INTEGER;
        RAISE EXCEPTION 'Expected application-role ALTER TABLE tickets to be rejected.';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
        ALTER TABLE venue_availability_hours ADD COLUMN app_role_ddl_probe INTEGER;
        RAISE EXCEPTION 'Expected application-role ALTER TABLE venue availability to be rejected.';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
        DROP TABLE tickets;
        RAISE EXCEPTION 'Expected application-role DROP TABLE tickets to be rejected.';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
        DROP TABLE event_series;
        RAISE EXCEPTION 'Expected application-role DROP TABLE event series to be rejected.';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
        DROP TABLE audit_logs;
        RAISE EXCEPTION 'Expected application-role DROP TABLE to be rejected.';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;
    END;

    UPDATE clubs SET deleted_at = NOW() WHERE id = club_id;
    INSERT INTO clubs (id, name, slug, created_by_id)
    VALUES (gen_random_uuid(), 'Replacement Constraint Club', 'constraint-test-club', organizer_id);

    UPDATE event_categories SET deleted_at = NOW() WHERE id = category_id;
    INSERT INTO event_categories (id, name, slug)
    VALUES (gen_random_uuid(), 'Constraint Tests', 'constraint-tests');

    UPDATE venues SET deleted_at = NOW() WHERE id = venue_id;
    INSERT INTO venues (id, name, slug, capacity)
    VALUES (gen_random_uuid(), 'Replacement Constraint Venue', 'constraint-test-venue', 100);

    INSERT INTO events (
        id, title, slug, description, start_at, end_at, club_id, category_id, created_by_id
    )
    VALUES (
        deleted_event_id, 'Soft Deleted Event', 'constraint-reusable-event-slug', 'Test fixture.',
        v_start_at, v_start_at + INTERVAL '1 hour', club_id, category_id, organizer_id
    );
    UPDATE events SET deleted_at = NOW() WHERE id = deleted_event_id;
    INSERT INTO events (
        id, title, slug, description, start_at, end_at, club_id, category_id, created_by_id
    )
    VALUES (
        deleted_event_replacement_id, 'Replacement Event', 'constraint-reusable-event-slug', 'Test fixture.',
        v_start_at, v_start_at + INTERVAL '1 hour', club_id, category_id, organizer_id
    );

    INSERT INTO notifications (id, user_id, dedupe_key, type, title, body)
    VALUES (gen_random_uuid(), student_id, 'constraint-reusable-notification', 'RSVP_CONFIRMED', 'Test', 'Test');
    UPDATE notifications
    SET deleted_at = NOW()
    WHERE dedupe_key = 'constraint-reusable-notification';
    INSERT INTO notifications (id, user_id, dedupe_key, type, title, body)
    VALUES (gen_random_uuid(), student_id, 'constraint-reusable-notification', 'RSVP_CONFIRMED', 'Test', 'Test');
END;
$$;

ROLLBACK;
