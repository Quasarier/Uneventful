ALTER TABLE refresh_tokens
ADD COLUMN google_authenticated_at TIMESTAMPTZ(3);

WITH family_authentication_times AS (
    SELECT id, MIN(created_at) OVER (PARTITION BY family_id) AS authenticated_at
    FROM refresh_tokens
)
UPDATE refresh_tokens AS refresh
SET google_authenticated_at = family.authenticated_at
FROM family_authentication_times AS family
WHERE refresh.id = family.id;

ALTER TABLE refresh_tokens
ALTER COLUMN google_authenticated_at SET NOT NULL;

ALTER TABLE refresh_tokens
ALTER COLUMN google_authenticated_at SET DEFAULT now();
