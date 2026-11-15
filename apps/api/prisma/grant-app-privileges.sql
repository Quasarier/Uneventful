GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uneventful_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO uneventful_app;

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM uneventful_app;
REVOKE ALL ON TABLE public._prisma_migrations FROM uneventful_app;
