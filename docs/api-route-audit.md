# API route inventory and security audit

The route inventory below was regenerated from Nest controller/module metadata with:

```sh
corepack pnpm --filter @uneventful/api routes
```

## Generated routes

```text
DELETE /api/v1/events/:id
DELETE /api/v1/events/:id/rsvp
DELETE /api/v1/me/push-subscriptions
DELETE /api/v1/venues/:id
GET /api/v1/auth/google
GET /api/v1/auth/google/callback
GET /api/v1/auth/me
GET /api/v1/events
GET /api/v1/events/:id
GET /api/v1/events/:id/attendees
GET /api/v1/events/:id/checkin-manifest
GET /api/v1/events/:id/checkins/lookup
GET /api/v1/events/:id/image
GET /api/v1/events/:id/rsvp/status
GET /api/v1/health/live
GET /api/v1/health/ready
GET /api/v1/me/notification-preferences
GET /api/v1/rsvps/me
GET /api/v1/venues
GET /api/v1/venues/:id
PATCH /api/v1/events/:id
PATCH /api/v1/me/notification-preferences
PATCH /api/v1/venues/:id
POST /api/v1/auth/logout
POST /api/v1/auth/logout-all
POST /api/v1/auth/refresh
POST /api/v1/events
POST /api/v1/events/:id/approve
POST /api/v1/events/:id/cancel
POST /api/v1/events/:id/checkins
POST /api/v1/events/:id/checkins/manual
POST /api/v1/events/:id/checkins/sync
POST /api/v1/events/:id/image-upload
POST /api/v1/events/:id/image-upload/confirm
POST /api/v1/events/:id/reject
POST /api/v1/events/:id/rsvp
POST /api/v1/events/:id/rsvp/ticket
POST /api/v1/events/:id/submit
POST /api/v1/events/series
POST /api/v1/me/push-subscriptions
POST /api/v1/unsubscribe
POST /api/v1/venues
POST /api/v1/venues/conflicts
```

## Stage 6 identity and RSVP read routes

| Route                                | Authorization and response scope                                                                                                                                                                                            | Cache and rate limits                                                                                                                | Integration coverage                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/auth/me`                | Requires a bearer principal; profile lookup uses only the authenticated principal's ID. Returns the current user's allowlisted public profile, never a token version or another user's email.                               | `Cache-Control: private, no-store`; global authenticated API rate limit.                                                             | `keeps profile and RSVP read responses scoped to the requesting student` in `apps/api/test/rsvps.integration.ts`.                                                                                                                                                                                     |
| `GET /api/v1/rsvps/me`               | Requires `STUDENT`; query is constrained to the authenticated user and active RSVPs. The response includes the user's own RSVP and safe ticket metadata, not user IDs, token versions, or other attendees' email addresses. | `Cache-Control: private, no-store`; global authenticated API rate limit.                                                             | `keeps profile and RSVP read responses scoped to the requesting student` in `apps/api/test/rsvps.integration.ts`.                                                                                                                                                                                     |
| `GET /api/v1/events/:id/rsvp/status` | Requires a bearer principal; returns only that principal's status plus event capacity counts. Hidden and unknown events use the same masked 404; visible past events return 409.                                            | `Cache-Control: private, no-store`; global authenticated API rate limit and per-user RSVP limit, returning `429` with `Retry-After`. | `returns an allowlisted no-store RSVP status for only the requesting student`, `masks hidden and unknown RSVP targets identically across create, cancel, and status`, and `returns 429 with Retry-After when RSVP status requests exceed the per-user limit` in `apps/api/test/rsvps.integration.ts`. |

These are defense-in-depth checks: the guards authenticate/authorize every non-public route, and repository queries are scoped to the current principal. The HTTP integration tests exercise the real Nest adapter, rate-limit service, PostgreSQL, and Redis.

## Stage 9 real-time dashboard

The Socket.IO namespace `/realtime` is served at the API origin using
websocket-only transport. Its message shapes, authorization, exact-origin
policy, Redis fanout, rate caps, and allowlisted dashboard payload are
specified in [the real-time dashboard contract](./realtime-dashboard.md).
The dashboard is not an HTTP route and therefore does not appear in the
generated route list above.

The gateway authenticates the handshake `auth.accessToken` with the normal
JWT/session-family validator; tokens in query strings are rejected. Only
admins and organizers with active membership in the event's club can join an
event room, and failed/unknown joins return the same masked response. The
gateway checks session and membership revocation on a three-second interval,
disconnects on token expiry/logout, and caps connections and messages.

The real PostgreSQL/Redis Socket.IO integration tests in
`apps/api/test/rsvps.integration.ts` cover masked joins, membership eviction,
session expiry and revocation, exact origin, connection/message limits,
post-commit-only updates, concurrent check-in count, allowlisted personal
data, and cross-instance Redis delivery. The Playwright real API test in
`apps/web/e2e/api-database.spec.ts` verifies the live count update, logout
state clearing, CSP, and axe accessibility.

## Stage 7 signed tickets and check-in

| Route                                     | Authorization and response scope                                                                                                                             | Cache, rate limit, and audit                                                               | Test evidence                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/events/:id/checkin-manifest` | Active event-club organizers and admins only; public keys plus paginated ticket-ID hashes/statuses, 500 per page.                                            | Private/no-store; per-user check-in limit; manifest download audited.                      | `provides a bounded no-store manifest and audited allowlisted manual lookup` in `apps/api/test/rsvps.integration.ts`.                                                                                                                                                                                                                                                                               |
| `POST /api/v1/events/:id/checkins`        | Active event-club organizers and admins only; verifies Ed25519 `kid`, claims, expiry, event, RSVP and ticket state; one atomic `ISSUED` → `USED` transition. | Private/no-store; per-user check-in limit; successful scan audited.                        | `checks one of fifty concurrent scans in and returns ALREADY_USED for every replay`, `rejects forged, wrong-event, expired and wrong-kid tickets with masked 404 responses`, and `issues signed ticket IDs and does not reset a USED ticket during regeneration` in `apps/api/test/rsvps.integration.ts`; signature/key-rotation unit cases in `apps/api/src/rsvps/ticket-signing.service.spec.ts`. |
| `POST /api/v1/events/:id/checkins/sync`   | Active event-club organizers and admins only; up to 50 hashes per batch, per-item invalid/duplicate/wrong-event results.                                     | Private/no-store; per-user check-in limit; each item and successful check-in audited.      | `syncs offline scans idempotently and returns per-item invalid and wrong-event results` in `apps/api/test/rsvps.integration.ts`.                                                                                                                                                                                                                                                                    |
| `GET /api/v1/events/:id/checkins/lookup`  | Active event-club organizers and admins only; display name, RSVP status, RSVP ID and check-in time only, page size capped at 100.                            | Private/no-store; per-user check-in limit; lookup audited without storing the search term. | `provides a bounded no-store manifest and audited allowlisted manual lookup` in `apps/api/test/rsvps.integration.ts`.                                                                                                                                                                                                                                                                               |
| `POST /api/v1/events/:id/checkins/manual` | Active event-club organizers and admins only; checks in a confirmed attendee by RSVP ID.                                                                     | Private/no-store; per-user check-in limit; scanner, time and device ID audited.            | `provides a bounded no-store manifest and audited allowlisted manual lookup` in `apps/api/test/rsvps.integration.ts`.                                                                                                                                                                                                                                                                               |

Students and organizers without active event-club membership receive a masked 404 on every check-in route, as covered by `masks every check-in route from students and organizers outside the event club` in `apps/api/test/rsvps.integration.ts`. `enforces the per-user check-in rate limit with Retry-After` covers the check-in-specific limiter. Ticket signatures are validated with Ed25519; only the ticket UUID hash and authoritative state are stored. The scanner persists public manifest data and queued hashes/timestamps/device IDs only; it clears event-local data on logout and when the active scanner observes event end.

## Stage 8 venues and bookings

| Route                                                                                                                                                                                                                   | Authorization and response scope                                                                                                                                                                                           | Cache, rate limit, and audit                                                 | Integration coverage                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/venues` and `GET /api/v1/venues/:id`                                                                                                                                                                       | Authenticated users can read active venue summaries; inactive or unknown venues are masked with the same 404 for non-admins. DTOs expose only venue identity, building, capacity, buffer, active state, and weekday hours. | Private/no-store responses.                                                  | `limits venue management to admins and returns masked 404s for inactive venues` in `apps/api/test/events.integration.ts`.                                                        |
| `POST /api/v1/venues`, `PATCH /api/v1/venues/:id`, `DELETE /api/v1/venues/:id`                                                                                                                                          | Administrators only; updates and retirement affect allowlisted fields.                                                                                                                                                     | Per-user write rate limit; every change is audited.                          | `limits venue management to admins and returns masked 404s for inactive venues`.                                                                                                 |
| `POST /api/v1/venues/conflicts`                                                                                                                                                                                         | Organizer with active membership when an event ID is supplied, or administrator; returns safe slot bounds and at most three available alternatives.                                                                        | Private/no-store; per-user conflict-check limit.                             | `reports safe booking conflicts and excludes occupied or inactive venues from alternatives` and `checks buffer, capacity, availability hours, past starts, and inactive venues`. |
| `POST /api/v1/events`, `PATCH /api/v1/events/:id`, `POST /api/v1/events/:id/submit`, `POST /api/v1/events/:id/approve`, `POST /api/v1/events/:id/reject`, `POST /api/v1/events/:id/cancel`, `DELETE /api/v1/events/:id` | Existing event/club authorization applies. Venue changes and status transitions synchronize booking state transactionally; delete soft-deletes and releases the reservation.                                               | Per-user booking-write limit; event and booking changes are audited.         | `serializes 20 competing booking updates so exactly one approved booking wins` and `releases venue slots on reject, cancel, and delete`.                                         |
| `POST /api/v1/events/series`                                                                                                                                                                                            | Organizer with active club membership or administrator; bounded daily, weekly, or monthly series with exception dates, maximum 52 occurrences. All occurrences are checked and committed atomically.                       | Per-user booking-write limit; series, event, and booking writes are audited. | `creates recurring bookings atomically, applies exception dates, and caps occurrences`; DST and interval properties in `apps/api/src/venues/venue-time.spec.ts`.                 |
| Venue conflict and event/venue booking writes                                                                                                                                                                           | Each endpoint fails closed on limiter failure and returns `429` with `Retry-After`.                                                                                                                                        | Rate-limit keys are per authenticated user.                                  | `rate-limits venue checks and booking writes with Retry-After` in `apps/api/test/events.integration.ts`.                                                                         |

Booking writes serialize on a venue-row lock and retain the PostgreSQL GiST exclusion constraint as the final overlapping-approved-booking guard. Event instants are UTC; venue availability is interpreted using validated `CAMPUS_TIME_ZONE`. Conflict responses never include the other event's or organizer's details.

## Stage 10 email and web-push notifications

| Route                                                                        | Authorization and response scope                                                                                                    | Cache, rate limit, and audit                                                                                         | Integration coverage                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/me/notification-preferences`                                    | Authenticated user only; allowlisted channel/type/enabled values and that user's subscription count.                                | Private/no-store; per-user limit.                                                                                    | `returns allowlisted defaults with no-store headers and keeps preferences self-scoped` in `apps/api/test/notifications.integration.ts`.                                        |
| `PATCH /api/v1/me/notification-preferences`                                  | Authenticated user only; DTO rejects unknown fields, duplicates, and unsupported enum values.                                       | Private/no-store; per-user limit; preference and consent audit rows are transactional.                               | `rejects unknown preference fields and rate limits settings with Retry-After`; preference/audit assertions in the self-scope test.                                             |
| `POST /api/v1/me/push-subscriptions`, `DELETE /api/v1/me/push-subscriptions` | Authenticated user's own HTTPS subscriptions only; endpoint ownership and per-user cap enforced server-side.                        | Private/no-store; per-user limit; subscription changes are audited.                                                  | `validates HTTPS push endpoints, enforces the per-user cap, and audits subscriptions`; `removes expired push subscriptions and limits push payloads to generic event details`. |
| `POST /api/v1/unsubscribe`                                                   | Public, signed email-unsubscribe token only; identical no-content response for invalid, expired, replayed, and unknown-user tokens. | No-store/no-referrer; per-IP rate limit returning `429` with `Retry-After`; consent and audit writes are idempotent. | `accepts one-click unsubscribe idempotently and rejects expired, tampered, and wrong-purpose tokens`.                                                                          |

Notification rows and channel deliveries are committed with RSVP/event writes;
the BullMQ dispatcher applies stable delivery job IDs, exponential retries,
and dead-letter handling. `apps/api/test/notifications.integration.ts` covers
dedupe, rollback, event/RSVP lifecycle notifications, reminders,
waitlist-promotion tickets, retry configuration, and delivery privacy.
`apps/api/src/notifications/notification-template.spec.ts` covers HTML
escaping, CR/LF-safe headers, and configured-origin event links. The settings
page preference update, click-only push prompt, CSP, and axe checks are in
`apps/web/e2e/accessibility.spec.ts` and `apps/web/e2e/security-headers.spec.ts`.
