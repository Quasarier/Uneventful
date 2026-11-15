\set ON_ERROR_STOP on
\getenv migrator_password UNEVENTFUL_MIGRATOR_DB_PASSWORD
\getenv app_password UNEVENTFUL_APP_DB_PASSWORD

CREATE ROLE uneventful_migrator
    LOGIN PASSWORD :'migrator_password'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

CREATE ROLE uneventful_app
    LOGIN PASSWORD :'app_password'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

SELECT format(
    'GRANT CONNECT ON DATABASE %I TO uneventful_migrator, uneventful_app',
    current_database()
) \gexec

SELECT format(
    'GRANT CREATE ON DATABASE %I TO uneventful_migrator',
    current_database()
) \gexec

ALTER SCHEMA public OWNER TO uneventful_migrator;
GRANT ALL ON SCHEMA public TO uneventful_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO uneventful_app;

ALTER DEFAULT PRIVILEGES FOR ROLE uneventful_migrator IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO uneventful_app;
ALTER DEFAULT PRIVILEGES FOR ROLE uneventful_migrator IN SCHEMA public
    GRANT USAGE ON TYPES TO uneventful_app;

SELECT current_database() || '_shadow' AS shadow_database \gset
SELECT format('CREATE DATABASE %I OWNER uneventful_migrator', :'shadow_database')
WHERE NOT EXISTS (
    SELECT 1 FROM pg_database WHERE datname = :'shadow_database'
) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO uneventful_migrator', :'shadow_database') \gexec

\connect :shadow_database
ALTER SCHEMA public OWNER TO uneventful_migrator;
GRANT ALL ON SCHEMA public TO uneventful_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
