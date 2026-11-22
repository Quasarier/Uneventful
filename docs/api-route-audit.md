# API route inventory and Stage 7 check-in audit

The route inventory below was regenerated from Nest controller/module metadata with:

```sh
corepack pnpm --filter @uneventful/api routes
```

## Generated routes

```text
DELETE /api/v1/events/:id/rsvp
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
GET /api/v1/rsvps/me
PATCH /api/v1/events/:id
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
```

## Stage 6 identity and RSVP read routes

| Route                                | Authorization and response scope                                                                                                                                                                                            | Cache and rate limits                                                                                                                | Integration coverage                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/auth/me`                | Requires a bearer principal; profile lookup uses only the authenticated principal's ID. Returns the current user's allowlisted public profile, never a token version or another user's email.                               | `Cache-Control: private, no-store`; global authenticated API rate limit.                                                             | `keeps profile and RSVP read responses scoped to the requesting student` in `apps/api/test/rsvps.integration.ts`.                                                                                                                                                                                     |
| `GET /api/v1/rsvps/me`               | Requires `STUDENT`; query is constrained to the authenticated user and active RSVPs. The response includes the user's own RSVP and safe ticket metadata, not user IDs, token versions, or other attendees' email addresses. | `Cache-Control: private, no-store`; global authenticated API rate limit.                                                             | `keeps profile and RSVP read responses scoped to the requesting student` in `apps/api/test/rsvps.integration.ts`.                                                                                                                                                                                     |
| `GET /api/v1/events/:id/rsvp/status` | Requires a bearer principal; returns only that principal's status plus event capacity counts. Hidden and unknown events use the same masked 404; visible past events return 409.                                            | `Cache-Control: private, no-store`; global authenticated API rate limit and per-user RSVP limit, returning `429` with `Retry-After`. | `returns an allowlisted no-store RSVP status for only the requesting student`, `masks hidden and unknown RSVP targets identically across create, cancel, and status`, and `returns 429 with Retry-After when RSVP status requests exceed the per-user limit` in `apps/api/test/rsvps.integration.ts`. |

These are defense-in-depth checks: the guards authenticate/authorize every non-public route, and repository queries are scoped to the current principal. The HTTP integration tests exercise the real Nest adapter, rate-limit service, PostgreSQL, and Redis.

## Stage 7 signed tickets and check-in

| Route                                     | Authorization and response scope                                                                                                                             | Cache, rate limit, and audit                                                               | Test evidence                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/events/:id/checkin-manifest` | Active event-club organizers and admins only; public keys plus paginated ticket-ID hashes/statuses, 500 per page.                                            | Private/no-store; per-user check-in limit; manifest download audited.                      | `provides a bounded no-store manifest and audited allowlisted manual lookup` in `apps/api/test/rsvps.integration.ts`.                                                                                                                                                                                                                                                                               |
| `POST /api/v1/events/:id/checkins`        | Active event-club organizers and admins only; verifies Ed25519 `kid`, claims, expiry, event, RSVP and ticket state; one atomic `ISSUED` → `USED` transition. | Private/no-store; per-user check-in limit; successful scan audited.                        | `checks one of fifty concurrent scans in and returns ALREADY_USED for every replay`, `rejects forged, wrong-event, expired and wrong-kid tickets with masked 404 responses`, and `issues signed ticket IDs and does not reset a USED ticket during regeneration` in `apps/api/test/rsvps.integration.ts`; signature/key-rotation unit cases in `apps/api/src/rsvps/ticket-signing.service.spec.ts`. |
| `POST /api/v1/events/:id/checkins/sync`   | Active event-club organizers and admins only; up to 50 hashes per batch, per-item invalid/duplicate/wrong-event results.                                     | Private/no-store; per-user check-in limit; each item and successful check-in audited.      | `syncs offline scans idempotently and returns per-item invalid and wrong-event results` in `apps/api/test/rsvps.integration.ts`.                                                                                                                                                                                                                                                                    |
| `GET /api/v1/events/:id/checkins/lookup`  | Active event-club organizers and admins only; display name, RSVP status, RSVP ID and check-in time only, page size capped at 100.                            | Private/no-store; per-user check-in limit; lookup audited without storing the search term. | `provides a bounded no-store manifest and audited allowlisted manual lookup` in `apps/api/test/rsvps.integration.ts`.                                                                                                                                                                                                                                                                               |
| `POST /api/v1/events/:id/checkins/manual` | Active event-club organizers and admins only; checks in a confirmed attendee by RSVP ID.                                                                     | Private/no-store; per-user check-in limit; scanner, time and device ID audited.            | `provides a bounded no-store manifest and audited allowlisted manual lookup` in `apps/api/test/rsvps.integration.ts`.                                                                                                                                                                                                                                                                               |

Students and organizers without active event-club membership receive a masked 404 on every check-in route, as covered by `masks every check-in route from students and organizers outside the event club` in `apps/api/test/rsvps.integration.ts`. `enforces the per-user check-in rate limit with Retry-After` covers the check-in-specific limiter. Ticket signatures are validated with Ed25519; only the ticket UUID hash and authoritative state are stored. The scanner persists public manifest data and queued hashes/timestamps/device IDs only; it clears event-local data on logout and when the active scanner observes event end.
