# Dependency Security Baseline

Reviewed: 2026-11-21

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
