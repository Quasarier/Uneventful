# Uneventful

Uneventful is a pnpm monorepo with a Next.js web app and a NestJS API.

See [Agent Rules](./docs/AGENT_RULES.md) for the repository's security, Git,
testing, and task-reporting requirements.

## Requirements

- Node.js 22.13 or newer
- Corepack-enabled pnpm 10.7.1 or newer
- Docker Compose

## Local setup

1. Copy `.env.example` to `.env`, then replace its sample values. The OAuth values must come from a Google OAuth client configured for your local callback URL.
   The API also requires an RSA key pair for access-token signing. In PowerShell, generate a local pair and start the apps from the same terminal so the PEM values are inherited without printing or committing them:

   ```powershell
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out .\jwt-private.pem
   openssl pkey -in .\jwt-private.pem -pubout -out .\jwt-public.pem
   $env:JWT_PRIVATE_KEY_B64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\jwt-private.pem"))
   $env:JWT_PUBLIC_KEY_B64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\jwt-public.pem"))
   ```

   The API also requires a separate Ed25519 key pair for signed QR tickets. Generate PKCS#8 private-key and SPKI public-key DER files, then load their base64 values without printing them:

   ```powershell
   openssl genpkey -algorithm ED25519 -out .\ticket-private.pem
   openssl pkcs8 -topk8 -nocrypt -in .\ticket-private.pem -outform DER -out .\ticket-private.der
   openssl pkey -in .\ticket-private.pem -pubout -outform DER -out .\ticket-public.der
   $env:TICKET_SIGNING_PRIVATE_KEY_B64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\ticket-private.der"))
   $env:TICKET_SIGNING_PUBLIC_KEY_B64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\ticket-public.der"))
   $env:TICKET_SIGNING_KEY_ID = "ticket-local-2026-01"
   ```

   Keep both private key files and their environment values private. PEM and DER files are ignored by Git. For production, store OAuth credentials, signing keys, session secret, and database credentials in the deployment platform's secret manager; never put production values in `.env` files or CI logs. Follow [the JWT signing-key rotation procedure](docs/authentication-key-rotation.md) for JWT rotations; ticket signing keys use the separate `TICKET_SIGNING_*` variables, with a current private/public pair and optional previous public key/`kid` pair for verification during rotation.

2. Install dependencies:

   ```powershell
   corepack pnpm install
   ```

3. Start PostgreSQL, Redis, the API, and web app together with one command:

   ```powershell
   corepack pnpm dev
   ```

   The API validates its required environment variables before it starts. It listens on port `3001` by default; the web app listens on port `3000`. Docker Compose services can also be started separately with `corepack pnpm dev:services`; use `corepack pnpm dev:apps` to run only the API and web app.

4. Install Gitleaks locally so the Husky pre-commit hook can scan staged changes. Go is not required. Choose either option:

   - **Binary (recommended):** Download the Windows AMD64 or ARM64 archive for [Gitleaks v8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1), extract `gitleaks.exe` into a directory on your `PATH`, then open a new terminal and verify it with `gitleaks version`.
   - **Docker fallback:** Install and start Docker Desktop, and ensure the `docker` command is available. If the Gitleaks binary is not installed, the pre-commit hook runs the pinned `zricethezav/gitleaks:v8.30.1` image and mounts the repository read-only. Docker downloads the image on its first use.

   The hook fails with an installation message if neither Gitleaks nor Docker is available. CI installs the same pinned Gitleaks version automatically.

## Authentication API

The API starts Google OIDC at `GET /api/v1/auth/google`. `GOOGLE_CALLBACK_URL` must be the fixed `/api/v1/auth/google/callback` URI registered in the Google OAuth client's authorized redirect URIs; the callback and popup destinations are configuration-only and never use caller-supplied redirect parameters. The callback validates the OIDC signature, audience, issuer, nonce, hosted-domain claim, verified email, and exact email domain before creating or updating a user. The API redirects the popup to the configured web origin with only a success/error status. The popup posts only that status to the explicit web-origin target; the opener accepts it only from the opened popup and exact configured origin, then fetches the session from the API. No token is sent through `postMessage`. The rotating refresh token uses an HttpOnly, Secure, SameSite=Lax `__Secure-` cookie.

`POST /api/v1/auth/refresh` rotates the refresh cookie and returns a new 15-minute access token; send the configured web origin, include credentials, and include `X-Uneventful-CSRF: 1`. `POST /api/v1/auth/logout` requires the same Origin and custom header and revokes the refresh-token family. Authenticated `POST /api/v1/auth/logout-all` uses bearer authentication, revokes all refresh tokens, and increments the user's token version. A database trigger increments the token version and revokes refresh sessions on every role change, including direct application-role updates. All other API routes require a valid access token unless explicitly marked `@Public()`.

Authenticated `GET /api/v1/auth/me` returns only the current user's public profile fields and is marked private/no-store.

Authenticated API requests are limited to 300 per minute per user through Redis. RSVP status, RSVP, and ticket actions have a separate configurable per-user limit (`RSVP_RATE_LIMIT_PER_MINUTE`, default 10, maximum 120). Check-in API actions have a separate per-user limit (`CHECKIN_RATE_LIMIT_PER_MINUTE`, default 120, maximum 500). Anonymous requests use a separate, configurable per-IP limit (`ANONYMOUS_RATE_LIMIT_PER_MINUTE`, default 1,200 and minimum 301); OAuth start and callback IP limits are separately configurable with `GOOGLE_OAUTH_START_RATE_LIMIT_PER_15_MINUTES` and `GOOGLE_OAUTH_CALLBACK_RATE_LIMIT_PER_15_MINUTES` (both default to 1,200). Verified-account callbacks remain limited to 10 per 15 minutes. Campus networks commonly place many people behind one NAT IP, so anonymous users on the same campus egress share an IP bucket; authenticated users do not share that bucket. Limits fail closed with a service-unavailable response if Redis cannot enforce them on protected API and authentication routes. `/api/v1/health/live` does not use Redis, while `/api/v1/health/ready` checks both PostgreSQL and Redis. `TRUST_PROXY_HOPS` defaults to `0`; set it only to the exact number of trusted reverse-proxy hops so client IP limits cannot be bypassed by spoofed forwarding headers. Helmet supplies API security headers, and credentialed CORS accepts only the configured `WEB_ORIGIN`. JSON and URL-encoded API request bodies are capped at 64 KiB, including chunked requests without `Content-Length`; image bytes are uploaded directly to the private object-storage staging prefix under the separately constrained signed policy.

The generated route inventory and security controls for the Stage 6 identity and RSVP read routes are documented in the [API route audit](./docs/api-route-audit.md). Regenerate the inventory from Nest controller/module metadata with `corepack pnpm --filter @uneventful/api routes`.

For manual verification with a dedicated Google development project, follow the [OAuth test checklist](docs/oauth-manual-test-checklist.md).

## Events API

The authenticated events API supports `GET /api/v1/events` with `page` (maximum 10,000), `limit` (maximum 100), `categoryId`, `clubId`, `startDate`, `endDate`, and `q` filters; `GET /api/v1/events/:id`; `POST /api/v1/events`; and `PATCH /api/v1/events/:id`. Date-only `endDate` values include the entire UTC day. Students can read only public, approved events. Organizers can read public approved events and events belonging to clubs where they hold active membership; admins can read all events. Organizers can manage events only for clubs where they hold active membership; admins can manage all clubs. Event responses use an explicit field allowlist and omit internal uploader keys and creator/approver IDs. Nested club/category objects contain only names and slugs. Rejection reasons are visible only to active club members and admins. New events start as `DRAFT`. Organizers submit drafts or rejected events with `POST /:id/submit`; admins approve or reject pending events with `POST /:id/approve` or `POST /:id/reject` (rejection requires a reason). An admin cannot approve an event they created. Authorized organizers and admins cancel with `POST /:id/cancel`. Editing an approved event returns it to `PENDING_APPROVAL`; `PATCH` does not accept `status`, `clubId`, creator, or approver fields. State transitions and event creation are written to the append-only audit log in the same database transaction.

`GET /api/v1/events/:id/attendees` is available only to admins and organizers with active membership in that event's club; all other callers receive a masked 404. It returns paginated display names, RSVP statuses, and waitlist positions only, with a hard page-size cap of 100. Cancelled attendees are omitted unless an admin explicitly filters for `status=CANCELLED`. Responses are private/no-store, requests use both global and per-user rate limits, and authorized reads are written to the append-only audit log.

Event descriptions are sanitized on the API using the documented tag, attribute, and protocol allowlist in `apps/api/src/events/event-description-sanitizer.ts`. Timestamps must include an explicit UTC offset and `timeZone` must be a valid IANA zone. Images use a private S3-compatible bucket configured with `OBJECT_STORAGE_BUCKET` and `OBJECT_STORAGE_REGION`; set `OBJECT_STORAGE_ENDPOINT` for a local S3-compatible service and supply credentials through the AWS SDK credential chain (use an IAM role in production).

The API generates an opaque key under `event-uploads/staging/<event-id>/` and issues a short-lived signed POST policy fixing the exact content type and limiting the body to 1–5 MiB. The uploader's user ID, event ID, key, and expiry are recorded together; only that user can confirm it for that event. Confirmation checks the stored size before reading, decodes with the exact-pinned `sharp` dependency (`limitInputPixels: 40_000_000`, 10-second processing timeout, one frame/page), verifies its actual format, applies EXIF orientation before re-encoding strips metadata, and writes a new server-generated object under `events/<event-id>/`. Animated WebP uploads are flattened to their first frame. The staging source is deleted in a `finally` path after success or processing failure; the staging lifecycle rule is a backstop if object storage is unavailable during cleanup. The untrusted staging key is never used as the final asset. Configure bucket Block Public Access on, Object Ownership as bucket-owner-enforced, ACLs disabled, and default encryption enabled. For S3 CORS, set `AllowedOrigins` to the exact `WEB_ORIGIN`, `AllowedMethods` to `POST` only, `AllowedHeaders` to only the upload form's required headers, and expose no headers unless the client needs a specific one. Do not enable public `GET`. Expire only `event-uploads/staging/` objects with a lifecycle rule (for example after one day); do not expire the `events/` prefix.

Example lifecycle rule (adjust the expiration period to the deployment's upload completion window):

```json
{
  "Rules": [
    {
      "ID": "expire-abandoned-event-image-uploads",
      "Status": "Enabled",
      "Filter": { "Prefix": "event-uploads/staging/" },
      "Expiration": { "Days": 1 }
    }
  ]
}
```

The authenticated `GET /api/v1/events/:id/image` API endpoint streams the normalized image with `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`, and private/no-store caching. It is rate-limited to 120 requests per minute by both client IP and authenticated user; Redis failures fail closed. Students can fetch only public, approved event images; organizers can fetch approved images and events belonging to their active clubs; admins can fetch all event images. Hidden/unknown event IDs return the same 404 response. Do not expose direct object-store GET URLs: S3 object metadata does not reliably supply these browser response headers, so image delivery must remain behind the API or an equivalent trusted proxy/CDN response-header policy. The client posts the signed form fields plus `file` to the returned URL, then calls `POST /api/v1/events/:id/image-upload/confirm`.

## Signed tickets and offline check-in

The API issues compact Ed25519-signed tickets with a `kid` header and exactly the `ticketId`, `eventId`, `rsvpId`, `issuedAt`, and `expiresAt` claims. Ticket expiry is two hours after the event end. The database stores only the SHA-256 hash of the ticket UUID and the authoritative `ISSUED`, `USED`, or `REVOKED` state; it never stores the signed token. The check-in transaction is the authority for one-time use, so signature validation and offline manifest status checks do not replace the atomic server-side state change.

Organizers with active membership in the event club and admins can download a paginated, private/no-store manifest, check in a signed QR ticket, synchronize up to 50 offline scans per request, and look up attendees by display name for manual check-in. Each page of the manifest is capped at 500 ticket hashes and includes only public verification keys. Access is masked with 404s for unauthorized users and hidden/unknown events; invalid ticket scans also use a masked 404. Check-in and manifest actions are rate-limited per user and audited.

The dedicated `/events/:id/scanner` page uses the browser's native `BarcodeDetector` and WebCrypto Ed25519 support. There is no JavaScript cryptography fallback: if Ed25519 key import or signature verification is unavailable or fails, the ticket is rejected as `INVALID`, is not queued, and is not accepted. The scanner verifies signatures using the downloaded public-key set and stores only event-scoped manifest data (public keys and ticket-ID hashes) plus queued ticket-ID hashes, scan timestamps, and device IDs in IndexedDB. It does not store ticket tokens or access tokens in IndexedDB, localStorage, or sessionStorage. The queue is synchronized when online and cleared with its manifest on logout and when the scanner observes that the event has ended; while the scanner page is closed, browser code cannot run, so expired data is removed when the page is next opened. Offline state is device-local and is not authoritative: multiple offline devices can independently show `VALID` for the same ticket using stale manifests. On synchronization, the first server-recorded check-in wins and later scans are reported as duplicates.

## Uneventful web frontend

The Next.js app provides a Google sign-in landing page and authenticated pages for event discovery, event details and RSVP, club discovery, tickets, calendar/iCal export, profile, the dedicated organizer check-in scanner, and an event-day live dashboard. Routes that need authentication refresh the HttpOnly-cookie session on demand; the access token stays in React memory and is never placed in browser storage. The typed client uses `openapi-fetch` with generated types from `apps/api/openapi.yaml`; regenerate them after contract changes with `corepack pnpm --filter @uneventful/web api:types`.

The event-day dashboard uses the API's websocket-only Socket.IO `/realtime`
namespace. It authenticates with the in-memory access token in the handshake
`auth` payload (never in a URL), and allows only admins or organizers with
active membership in the event club. The Redis adapter distributes committed
check-in updates across API instances. Dashboard payloads contain attendance
counts, capacity, and recent attendee display names and times only; logout
disconnects the socket and clears the in-memory view. See the [real-time
dashboard contract](./docs/realtime-dashboard.md) for message and security
details.

The club directory is derived from public event data, so it lists clubs with discoverable public events rather than clubs with no public events. The ticket page issues a signed ticket only when requested, keeps the raw token in component memory, and displays its QR code without persisting it. The scanner route alone enables camera permission; other routes use `camera=()`. The service worker precaches only `/offline.html` and `/icons/icon.svg`, serves the icon cache-first, and uses network-first navigation with the offline page as fallback. It does not cache API requests, requests carrying `Authorization`, responses carrying `Set-Cookie` or `Cache-Control: no-store`, or page navigations; it removes older static caches on activation and clears app caches on logout. The API's `GET /api/v1/events/:id/rsvp/status` and `GET /api/v1/rsvps/me` responses are private/no-store; the latter returns only the current student's active RSVP and safe ticket metadata.

The web app requires `NEXT_PUBLIC_WEB_ORIGIN` and `NEXT_PUBLIC_API_BASE_URL` to match the configured deployment origins. In local development, set them to `http://localhost:3000` and `http://localhost:3001/api/v1`, respectively; OAuth refresh cookies remain Secure and should be tested in a browser context that can use those cookie settings.

## Verification

```powershell
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

The API has PostgreSQL-backed authentication and events HTTP integration tests. They require a disposable, migrated test database. Event fixtures clean up dependent rows, but intentionally retain actors referenced by append-only audit records; use a fresh database for each run. `TEST_DATABASE_URL` must be the application-role connection string, and `TEST_MIGRATION_DATABASE_URL` must be the separate migration-role connection string for privileged fixture cleanup:

```powershell
$env:TEST_DATABASE_URL = "postgresql://uneventful_app:<test-password>@localhost:5432/uneventful_ci?schema=public"
$env:TEST_MIGRATION_DATABASE_URL = "postgresql://uneventful_migrator:<migration-password>@localhost:5432/uneventful_ci?schema=public"
$env:TEST_REDIS_URL = "redis://localhost:6379"
corepack pnpm --filter @uneventful/api test:integration
```

CI provisions the PostgreSQL and Redis test services and runs the integration suite automatically.

To run the same API integration suite locally against fresh PostgreSQL 17 and Redis 7 containers, with separate least-privilege application and migration roles, run this from the repository root:

```bash
bash scripts/test-integration-local.sh
```

The script requires Docker, Node.js, and Corepack/pnpm dependencies to be installed. It publishes the containers only on loopback using automatically assigned non-default ports, generates throwaway credentials, applies every migration to a new database as `uneventful_migrator`, and runs the integration tests with `uneventful_app`. It rejects preconfigured database or Redis URLs whose host is not localhost, and removes both containers on success, failure, or interruption.

Docker Compose reads the root `.env` file automatically. Database and Redis credentials have no Compose defaults; startup fails if the required variables are absent. On a new PostgreSQL data volume, Compose creates the separate `uneventful_migrator` and `uneventful_app` roles from the two role-password variables. If the volume already exists, run the provisioning SQL once as the database bootstrap user:

```powershell
docker compose cp apps/api/prisma/provision-roles.sql postgres:/tmp/provision-roles.sql
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /tmp/provision-roles.sql'
```

The application connects only with `DATABASE_URL`; Prisma migration commands use `MIGRATION_DATABASE_URL`. The migration role has schema/DDL privileges but is not a superuser and cannot create databases or roles. Provisioning also creates a dedicated shadow database for local `migrate dev`; `SHADOW_DATABASE_URL` points to it. Production deploys should use `db:deploy`, which reapplies runtime grants after migrations. The application role has no schema-create or table-ownership privileges, cannot alter or drop tables, cannot access Prisma migration metadata, and cannot update, delete, or truncate audit logs.

## Database schema, migrations, and seed

The Prisma schema is in `apps/api/prisma/schema.prisma`. From the repository root, use:

```powershell
corepack pnpm --filter @uneventful/api db:validate
corepack pnpm --filter @uneventful/api db:generate
corepack pnpm --filter @uneventful/api db:migrate
corepack pnpm --filter @uneventful/api db:seed
```

`db:migrate` creates or applies a development migration. Production deploys should run `corepack pnpm --filter @uneventful/api db:deploy`; do not run `migrate dev` in production. The seed command exits with an error when `NODE_ENV=production` and is otherwise restricted to `development` and `test`. It creates repeatable example users and campus event data, but intentionally does not create tickets, check-ins, audit records, or refresh tokens.

Venue bookings use a PostgreSQL GiST exclusion constraint with half-open time ranges, so adjacent reservations are allowed while overlapping approved reservations for one venue are rejected. The migration enables `btree_gist`; the database migration role must be allowed to create that extension. CHECK constraints also reject non-positive capacities and invalid event/booking time ranges. Unique names and slugs on soft-deletable clubs, categories, venues, events, and notification dedupe keys are enforced only while a row is active. These partial unique indexes are migration-managed because Prisma does not represent their predicates; preserve them in future SQL migrations and query active rows with `deletedAt: null`. User email and Google subject remain globally unique to prevent reassignment of an account identity after soft deletion.

Venue creation, changes, and retirement are administrator-only; authenticated students and organizers can read active venue summaries. Event writes accept an optional venue and expected attendance. Booking writes lock the venue row and check the full time range, buffer, capacity, availability, and active state inside the same transaction as the event change. The GiST constraint remains the database backstop for overlapping approved bookings. Booking changes and venue changes are audited; conflict responses contain only conflicting slot times and up to three safe alternatives.

Event timestamps are stored in UTC. Venue hours are interpreted in the required, validated `CAMPUS_TIME_ZONE` IANA zone; set it to the campus's actual zone in each deployment (the example value is not a deployment default). Recurring event series are atomic, support daily/weekly/monthly rules capped at 52 occurrences, and allow exception dates. Weekly and other recurrence starts preserve campus wall-clock time across DST changes. Venue hours currently allow one same-day opening interval per weekday; overnight or multiple daily windows are not supported.

An RSVP row is unique per `(eventId, userId)`, including when cancelled. To RSVP again after cancellation, transactionally update that existing row from `CANCELLED` to `GOING` and clear its waitlist position, or to `WAITLISTED` with a positive position if capacity is unavailable; do not insert a second RSVP. If the RSVP already has a revoked ticket, reissue it by updating that ticket record rather than inserting another ticket. This preserves history and satisfies the database uniqueness constraints.

Students RSVP to public, approved events before the event starts with `POST /api/v1/events/:id/rsvp`; `{ "checkConflicts": true }` opts into blocking overlapping confirmed events. Capacity is serialized by locking the event row inside the PostgreSQL transaction, and full events receive monotonically assigned FIFO waitlist positions. `DELETE /api/v1/events/:id/rsvp` cancels a student's RSVP. When a confirmed RSVP frees capacity, a transactionally recorded outbox item is dispatched to BullMQ; the worker promotes one next waiter, issues a hashed ticket, and creates a durable in-app notification atomically. `POST /api/v1/events/:id/rsvp/ticket` signs a ticket for an active `GOING` RSVP; the token is returned only in no-store responses and never stored. Reissuing creates a fresh signed representation for the same ticket ID, while the ticket row's `USED` status cannot be reset. RSVP and ticket responses are rate-limited per student; check-in actions have their own per-user limit, and Redis failures fail closed. Notifications are stored in the in-app `notifications` table; no email or push delivery channel is configured.

Database regression fixtures run as the application role to check approved-booking overlap behavior, CHECK constraints, soft-delete key reuse, and denied audit-log/DDL operations. A separate migration-role fixture verifies the audit-log mutation and truncate triggers.
