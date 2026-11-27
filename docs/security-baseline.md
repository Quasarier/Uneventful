# Dependency Security Baseline

Reviewed: 2026-11-22

`pnpm audit` and OSV Scanner report no known vulnerabilities in the current
lockfile. The glob and minimatch advisories were removed from the baseline
after these exact pnpm overrides moved the locked transitive tooling
dependencies to patched releases:

| Dependency path              |  Requested version |           Override | Reason                                   |
| ---------------------------- | -----------------: | -----------------: | ---------------------------------------- |
| `apps__api>@nestjs/cli>glob` |      `glob@13.0.6` |      `glob@14.0.2` | Patched release for GHSA-3g3m-2fjr-6pw4. |
| `.>eslint>minimatch`         | `minimatch@10.2.6` | `minimatch@11.0.1` | Patched release for GHSA-g3hv-75wg-m249. |

Keep the overrides until the parent dependency ranges resolve to patched
versions without them. Re-run both `pnpm audit` and OSV Scanner after lockfile
changes and before releases.

## Frontend transport policy

The web middleware emits `Strict-Transport-Security: max-age=31536000` only
when `NODE_ENV=production`. It intentionally omits both `includeSubDomains`
and `preload`.

## Signed QR tickets and offline check-in

Ticket tokens are compact Ed25519 signatures with a `kid` and only the
`ticketId`, `eventId`, `rsvpId`, `issuedAt`, and `expiresAt` claims. Expiry is
the event end plus a fixed two-hour grace period. The current private key is
loaded only by the API from validated configuration; the public key set
contains the current and optional previous key. During rotation, retain the
previous public key until its tickets have expired and the grace period has
elapsed. Never place signing private keys in browser configuration, manifests,
responses, or logs.

The database stores `SHA-256(ticketId)` and the authoritative
`ISSUED`/`USED`/`REVOKED` state. Legacy bearer tickets are revoked by the
Stage 7 migration because their signed replacements cannot be reconstructed
from stored hashes. Check-in atomically changes `ISSUED` to `USED`; concurrent
scans and later duplicates cannot create a second check-in. RSVP status is
rechecked server-side, including after offline validation.

The scanner's IndexedDB database stores only event-scoped public key
manifests, ticket-ID hashes/statuses, and queued hashes with scan time and
device ID. It does not store access tokens or signed ticket tokens. This
device-local data is not authoritative and is cleared by logout and by the
active scanner when it observes event end. The scanner uses browser
`BarcodeDetector` and requires a supported browser and camera permission; the
camera feature is enabled only on the dedicated event scanner route.

## Venue booking and conflict controls

Venue management is restricted to administrators, while reads expose active
venue data through allowlisted DTOs. Event and venue writes are per-user
rate-limited and audited. Booking creation, changes, approval, rejection,
cancellation, and deletion are coordinated with the event transaction and
serialized by a venue-row lock. A PostgreSQL GiST exclusion constraint remains
the final guard against overlapping approved bookings; application conflict
checks do not replace it.

Event instants are persisted in UTC. Venue opening hours are interpreted in
`CAMPUS_TIME_ZONE`, validated as an IANA zone at startup. Recurring event series
are bounded to 52 occurrences, checked as a whole, and written atomically;
exception dates are supported, and recurring start times retain campus local
time across DST transitions. Conflict responses disclose only slot start/end
times and at most three active, capacity-suitable alternatives. The current
availability model supports one same-day interval per weekday, not overnight
or multiple daily windows.

## OWASP ZAP baseline exceptions

The local ZAP baseline scan reports three Low `Cross-Origin-Opener-Policy
Header Missing or Invalid` alerts (rule 90004) for `/`, `/events`, and `/login`.
The app uses `same-origin-allow-popups` so the Google sign-in popup can retain
its opener and report completion through the origin- and source-checked
`postMessage` flow. Replacing it with `same-origin` caused the trusted popup
sign-in E2E test to fail. The OAuth result page is scoped to
`Cross-Origin-Opener-Policy: unsafe-none` for the same compatibility reason.

Review by **2026-12-21**. Remove this exception only after replacing the popup
completion channel with an opener-independent design and verifying the full
OAuth E2E journey. The ZAP CI job remains non-blocking until this baseline
exception is resolved or explicitly accepted.

## Real-time event dashboard

The `/realtime` Socket.IO namespace uses websocket-only transport and the Redis
adapter. The browser sends the in-memory access token in the Socket.IO
handshake `auth` payload, never in the query string. The API requires strict
equality between the handshake Origin and configured `WEB_ORIGIN`; credentialed
CORS uses that exact origin and never a wildcard. The web CSP `connect-src`
allows self plus only the configured API HTTP and corresponding WS(S) origins.

The gateway validates a live JWT session family on connect, reserves a
Redis-backed lease (at most three sockets per user), and disconnects on token
expiry or logout/revocation. It checks active club membership on each room join
and rechecks connected sessions and memberships every three seconds, removing
organizers from event rooms after membership loss. Inbound payloads are
allowlisted, limited to 4 KiB and 20 messages per connection per ten seconds,
and each socket can join at most ten event rooms.

Dashboard messages contain only the event ID, aggregate attendance counts and
ratio, capacity, and the ten most recent check-ins' display names and times.
Email addresses, user IDs, RSVP IDs, ticket hashes, and signed ticket tokens
are excluded. Check-in broadcasts are issued only after a successful database
transaction commits; duplicates do not create additional check-ins or
broadcasts. The Redis adapter distributes committed updates across API
instances. The page uses ephemeral React state and disconnects/clears it on
logout; it does not persist dashboard data or credentials in browser storage.

## Email and web-push notifications

Notification preferences are scoped to the authenticated user and expose only
allowlisted channel/type/enabled fields. Email defaults on and push defaults
off. Preference changes and one-click email unsubscribe create consent and
append-only audit records; transactional email opt-outs require an explicit
opt-out record. The unsubscribe token uses a separate HMAC key from JWT and
ticket signing, expires, is idempotent, and returns the same no-content
response for valid and invalid or unknown-user tokens. Its unauthenticated POST
is rate-limited.

Delivery rows are inserted transactionally with the source RSVP/event update.
The dispatcher uses stable job IDs, a delivery lease, bounded exponential
retries, and dead-letter status. Resend receives the delivery ID as its
idempotency key. Web-push payloads contain only a generic title, event name,
and relative event link; they exclude user identity, email, RSVP, and ticket
data. The local/test email transport only records messages and never sends.
Production startup requires the configured Resend sender/credentials,
unsubscribe key, and complete VAPID settings.

Push subscription endpoints are accepted only over HTTPS, with DNS results
checked against private, loopback, and reserved IP ranges both on registration
and delivery. A DNS change between validation and the Web Push client's
connection remains a residual SSRF race because the provider library performs
its own resolution. Subscription ownership and a per-user cap are enforced
under a user-row lock; provider 404/410 responses remove subscriptions.
Templates HTML-escape database variables, strip CR/LF from subject/header
values, include a plain-text alternative, and use the configured web origin
for event links. Resend idempotency and push topic deduplication reduce
duplicate sends, but neither arbitrary external push providers nor a lost
provider response can provide a universal exactly-once delivery guarantee.

The notification integration suite verifies authenticated self-scoping,
allowlisted DTO validation, consent/audit rows, unsubscribe token variants and
rate limits, HTTPS/private push endpoint rejection, subscription caps and
410 cleanup, transactional outbox deduplication/rollback, reminder
cancellation/rescheduling, waitlist promotion, email escaping/header
injection resistance, push payload privacy, Redis quotas, BullMQ retry
configuration, and dead-letter behavior. The settings page has Playwright
coverage for preference updates, click-only push permission, CSP headers, and
axe accessibility.

## Organizer analytics, CSV export, and recommendations

Event/club analytics are SQL aggregates and use a configurable minimum group
size (`ANALYTICS_MIN_GROUP_SIZE`, default 5). Counts below the minimum are
returned as null or omitted; percentage values are suppressed unless both the
numerator and its complement meet the threshold. Date ranges are capped at 90
days and responses at 100 buckets. Queries use parameterized Prisma raw SQL
and validated campus time-zone bucketing. Responses are explicit allowlists,
private/no-store, and cached for 20 seconds under event/club-scoped keys.
RSVP, cancellation, and successful check-in mutations invalidate the matching
event, club, and user recommendation cache scopes.

Attendee export selects only display name, RSVP status, and check-in time,
fails if the 2,000-row cap would be exceeded, streams CSV rows, and audits the
actor, event, row count, and export time. Formula-leading `=`, `+`, `-`, `@`,
tab, and carriage return are neutralized; fields are quoted and escaped per
RFC 4180 and embedded CR/LF is replaced with spaces. UTF-8 BOM is included for
spreadsheet compatibility. The filename is normalized and bounded; responses
are `text/csv`, private/no-store, and `nosniff`.

Personalization is enabled by default and consent changes have timestamped
records and audit entries. Recommendations combine category/tag matches,
followed clubs, recency, popularity, and item-based co-attendance. The latter
is only used above `RECOMMENDATIONS_MIN_SUPPORT` distinct attendees (default
5). Opt-out avoids querying attendance history; a per-user cache is invalidated
on RSVP, follow, or preference changes. Recommendation output contains public
event fields and safe reasons only, and the explicit deletion endpoint clears
derived per-user cache data. No persisted derived profile is created.

The fixed-seed offline evaluation script reports precision@5 and candidate
coverage on synthetic data. This is a reproducibility smoke check only; it
does not validate production relevance, fairness, or privacy against a real
population. Account deletion is not currently exposed as an API flow; if
introduced, it must remove recommendation preferences/consent records and
purge the user's derived cache before the account is considered deleted.

## Administrator access and moderation

Every admin controller and the legacy event-approval/venue mutation routes
require both a valid active access-session family and the role currently
stored in PostgreSQL. Admin routes use a separate per-user Redis limiter,
`Cache-Control: private, no-store`, allowlisted request DTOs, and the same
masked 404 behavior for anonymous and non-admin callers as for unknown
resources. `ADMIN_IP_ALLOWLIST` is optional and accepts comma-separated IP
addresses or CIDR networks; empty disables it. The API must run behind only
the configured trusted proxy hops when this restriction is enabled.

Role grants require the requester's refresh-token family to have been created
within five minutes, and a different administrator must approve within 15
minutes. The requester and target cannot approve. Grant approval, role changes,
membership changes, account suspension/reactivation, and club verification
are serialized where needed, require reasons, append allowlisted before/after
values and actor IP to the immutable audit log, revoke refresh-token families,
increment token versions, publish socket revocation, and enqueue account
notifications. The last active administrator cannot be demoted or suspended.
The application database role has no `UPDATE`, `DELETE`, or `TRUNCATE`
privileges on `audit_logs`; the verification SQL exercises these denials and
the audit mutation triggers.

Suspending a club blocks future event creation/submission and cancels future
approved events. Those events are soft-hidden from non-admin event reads,
search, RSVP/calendar data, recommendations, attendee exports, and caches;
venue bookings and reminders are released and deduplicated cancellation
notifications are enqueued transactionally for organizers and attendees.
Moderation reports use fixed target/reason/action enums and a unique open
report key. Reporter identity is returned only to the admin report view and
not to club-facing APIs. Event takedown uses the same cancellation, venue,
reminder, notification, audit, and cache-invalidation path.

Stage 12 coverage currently includes real-PostgreSQL/Redis tests for active
admin session authorization and masking, admin rate-limit headers, fresh
reauthentication/two-person admin grants, club suspension cancellation,
notification deduplication, and affected recommendation-cache invalidation.
Report resolution, all-admin-route authorization, last-admin protection,
account suspension socket eviction, and the complete audit-field matrix still
need dedicated integration coverage before release.
