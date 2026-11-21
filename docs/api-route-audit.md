# API route inventory and Stage 6 read-route audit

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
