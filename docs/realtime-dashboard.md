# Real-time event dashboard contract

The API serves the Socket.IO namespace `/realtime` at the API origin. The
namespace uses websocket-only transport and the Redis adapter. It is not an
HTTP route and is not represented as a path in OpenAPI.

## Connection and authorization

- The handshake must have `Origin` exactly equal to configured `WEB_ORIGIN`.
  The Socket.IO CORS configuration uses that same single origin, enables
  credentials, and does not use a wildcard.
- Clients send `{ accessToken: "<short-lived access token>" }` in Socket.IO's
  handshake `auth` object. Tokens in query-string parameters are rejected.
- The API validates the JWT signature, issuer, audience, role, token version,
  active account, and active refresh-token family before accepting a socket.
  The socket is disconnected at token expiry or when its family/user is
  revoked.
- An administrator, or an organizer with an active membership in the event's
  club, may join that event's room. Membership is checked on each join and
  rechecked for connected sockets every three seconds. Unknown events and
  unauthorized joins return the same `{ ok: false, error: "Event not found." }`
  acknowledgement. Membership removal evicts an organizer from the room and
  emits only the event ID in a revocation notice.

## Messages

Client messages:

```ts
dashboard: join({ eventId: string }, acknowledge);
dashboard: leave({ eventId: string }, acknowledge);
```

Both payloads are strict schemas containing only a UUID `eventId`.
`dashboard:update` contains the following allowlisted snapshot:

```ts
{
  eventId: string;
  checkInCount: number;
  rsvpCount: number;
  attendanceRatio: number;
  capacity: number | null;
  recentCheckIns: Array<{
    displayName: string;
    checkedInAt: string;
  }>;
}
```

The payload never includes email addresses, user IDs, RSVP IDs, ticket hashes,
or signed ticket tokens. Check-in updates are queried and published only after
the database transaction commits; duplicate scans do not create an extra
check-in or broadcast. The Redis adapter distributes events across API
instances.

Each user may hold at most three concurrent socket connections. A connection
may join at most ten event rooms and send at most 20 messages per ten seconds.
Inbound application payloads are capped at 4 KiB; the Socket.IO server enforces
the same maximum at the transport layer. Invalid message types or oversized
messages disconnect the client.

## Browser handling

The Next.js dashboard sends its access token only in the handshake `auth`
object and stores dashboard snapshots in component memory. Before every
initial or reconnect handshake, it asks the auth provider for a valid
in-memory access token. The provider refreshes through the HttpOnly refresh
cookie when the token is expired or within 30 seconds of expiry. If refresh
fails, the client disconnects instead of repeatedly reconnecting with a stale
token. It clears the snapshot and disconnects when the session is cleared.
`connect-src` allows same-origin resources and only the configured API HTTP
and corresponding WS(S) origins. The dashboard renders connection, reconnect,
loading, and failure states and announces live data through an `aria-live`
region.
