BEGIN;

DO $$
DECLARE
    test_audit_id UUID := gen_random_uuid();
BEGIN
    IF current_user <> 'uneventful_migrator' THEN
        RAISE EXCEPTION 'Audit trigger checks must run as uneventful_migrator, not %.', current_user;
    END IF;

    INSERT INTO audit_logs (id, action, entity_type)
    VALUES (test_audit_id, 'immutability-test', 'audit_log');

    BEGIN
        UPDATE audit_logs SET action = 'tampered' WHERE id = test_audit_id;
        RAISE EXCEPTION 'Expected audit-log UPDATE trigger to reject the operation.';
    EXCEPTION
        WHEN integrity_constraint_violation THEN NULL;
    END;

    BEGIN
        DELETE FROM audit_logs WHERE id = test_audit_id;
        RAISE EXCEPTION 'Expected audit-log DELETE trigger to reject the operation.';
    EXCEPTION
        WHEN integrity_constraint_violation THEN NULL;
    END;

    BEGIN
        TRUNCATE audit_logs;
        RAISE EXCEPTION 'Expected audit-log TRUNCATE trigger to reject the operation.';
    EXCEPTION
        WHEN integrity_constraint_violation THEN NULL;
    END;
END;
$$;

ROLLBACK;
