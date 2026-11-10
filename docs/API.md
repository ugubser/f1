# API contract and client lifecycle

Base URL: `/api/v1`. Machine-readable OpenAPI 3.1: authenticated `GET /openapi.json`, generated from `openapi.mjs`. Every REST API request requires `Authorization: Bearer <application-token>`, including sign-in, media and stream-ticket issuance. A WebSocket is authenticated with a short-lived ticket issued by that protected API, before any application data is sent. The static UI is public. Browser preflight and the WebSocket upgrade are unauthenticated transport operations; neither provides application data without subsequent authorization. HTTP request bodies are JSON objects, limited to 16 KiB. Unknown body fields are rejected.

## Credentials

Generate the application token once with `npm run api:setup`; display it only in your interactive terminal with `npm run api:token`. It is not the F1 token. Do not place either in URL parameters. The included web UI loads its application token automatically from public `GET /ui-config.json`, populated at startup from ignored `public/.env` (`F1_UI_API_TOKEN`, mode `0600`). This bootstrap route intentionally distributes the application credential to anyone who can access the UI; it is not a bearer-protected application endpoint. It exposes only that configured value, never the raw file, server environment or F1 subscription token, and sends `Cache-Control: no-store`. All `/api/v1` operations still require the bearer. A missing/invalid UI environment stops normal server startup; a mismatched token is rejected by the API. Other clients may configure their token through their own environment or OS credential store. Rotation is an explicit replacement of private configuration followed by a service restart; existing streams close on shutdown. The server refuses to start without valid access configuration.

F1 login: `POST /f1/auth/login` with `{ "email": "your-account", "password": "your-password" }`. Credentials are transient; no request bodies are logged. Success returns status/expiry, never F1 tokens. `GET /f1/auth` checks status. Sign-in does not establish the live connection or prove upstream timing entitlement; `POST /live/connect` requests it, returning HTTP 202. Inspect `/live` or a live view's stream for actual connection/authorization results.

`POST /f1/auth/logout` with `{}` cancels pending authentication, stops the shared live connection and deletes local F1 sign-in. `POST /live/disconnect` stops only the connection. Logout does not revoke tokens at F1 or sign other F1 applications out. No automatic password login or refresh token is implemented. Standard email/password sign-in is supported; additional F1 interactions are explicit failures, not a switch to another method.

Local loopback development uses HTTP. Non-loopback credential submission requires TLS by default. `F1_ALLOW_HTTP_LOGIN=1` explicitly permits it over HTTP for the owner-authorized trusted LAN deployment. Bearer protection remains required and upstream F1 credential submission always uses HTTPS. The current server does not trust forwarded protocol headers; a later deployment must explicitly arrange TLS termination/trust before enabling remote sign-in. Browser origins must be the served origin or listed in `F1_ALLOWED_ORIGINS`; native clients omit Origin. All still require bearer authentication.

## Race discovery and asynchronous loading

`GET /races?year=2024` returns `races` and the season's `circuits`. Optional `month=1..12` and `circuit=<numeric-id>` filter races on the server. Only completed race sessions are accepted. Provider-native metadata fields in discovery are documented in the OpenAPI Race schema; normalized view data uses camelCase.

Create a view with `POST /views`:

```json
{"source":"history","raceId":9590}
```

HTTP 201 returns the view immediately with `status: "loading"`, `progress`, and a Location header. GET the view or subscribe to its WebSocket stream to follow server-managed loading. Each driver loads sequentially through the shared rate limiter. Optional source errors and missing driver positions are explicit in `availability` and `progress.missingDrivers`; they never trigger another provider. `ready` means loading finished; `error` means the replay could not load. To retry a failed race, PATCH the same `raceId`. Deleting a view cancels further loading when no other view references the dataset; an already dispatched upstream request can finish and cache, but no further car requests are dispatched for that abandoned load.

`POST /views` with `{ "source": "history" }` creates an empty view for later race selection. `{ "source": "live" }` creates a live view without starting F1.

## Independent view state

Each view owns source, historical race, playback clock, speed, selected driver, selected turn, overlays, notification filters and radio selection. Dataset contents and the F1 connection/account are shared. View IDs are not additional authorization credentials: application token holders are trusted as the same owner.

`PATCH /views/{id}` accepts any of:

```json
{
  "source":"history",
  "raceId":9590,
  "selectedDriver":81,
  "selectedTurn":"1",
  "notifications":["control","pit","radio"],
  "overlays":{"sectors":true,"turns":true,"names":false}
}
```

Set selections to null to clear them. PATCH does not replace omitted settings. Switching to live pauses the historical clock; switching back restores its position paused. Switching source does not disconnect the shared feed. Live turn availability stays explicit even if a client requests the turns setting. A new historical race resets driver/turn/radio selection. Invalid patches are rejected before changing state.

Views expire after 30 minutes without requests; active streams keep views alive. Maximum 12 views and 24 streams per process. DELETE a view when done. Views do not survive restart. The API returns `VIEW_NOT_FOUND`; recreate the view explicitly. `/system.instanceId` identifies server restarts. Live collection never automatically starts on boot.

## Replay clock and calculated frames

`POST /views/{id}/playback` accepts one command:

```json
{"action":"play"}
{"action":"pause"}
{"action":"seek","time":1725199200000}
{"action":"reset"}
{"action":"speed","speed":10}
```

These are separate JSON request examples, not one combined request. Supported speeds: 1, 5, 10, 30, 60. `seek` must lie within the returned playback start/end, and pauses replay. `reset` pauses at start. Speed changes preserve playing/paused state. Play at the end restarts from the beginning. Live views reject replay commands with `REPLAY_NOT_READY`.

The server owns a monotonic anchored replay clock, independent of request frequency or rendering frame rate. GET and WebSocket metadata return positions, lap, tires, gaps, notification state and selected details calculated at that same time. Clients format the returned values and draw/interpolate buffered supplied coordinate samples; race rules remain server-owned. No future notification/lap leakage, no gap interpolation and no estimates from XY distances. Position interpolation only spans short source gaps.

Numeric timestamps are UTC milliseconds. Radio offsets are seconds. Gaps are `{ "unit":"seconds"|"laps", "value":number }` or null, with status, source time and comparison driver IDs. Zero is a real value; null means unavailable. Positions carry `stale`; disconnected/stale live feeds have no current car location. Consumers must freeze/clear live movement when the server stream is lost.

Geometry contains the original session XY lap trace, colored sectors, aligned turns with optional names/sector attribution and a reference lap. Sector colors: S1 `#74bdff`, S2 `#c5a0ff`, S3 `#ffb472`. It is approximate, and may be null. Missing geometry is not permission to invent or borrow another track outline.

## WebSocket stream and buffered presentation

See [STREAMING.md](STREAMING.md) for the complete wire protocol. OpenAPI's `x-websocket` section references the machine-readable message schemas alongside the REST contract.

Request `POST /views/{id}/stream-ticket` with `{}` and the application bearer header. The HTTP 201 response contains a single-use ticket valid for 10 seconds and the relative `/api/v1/socket` URL. Open a WebSocket there and send `{ "type":"auth", "ticket":"..." }` as the first message. Never put tickets or bearer credentials in URLs. The server sends no application data before authentication, and rejects unsupported browser origins.

The stream starts with a full `snapshot`. Later `state` messages contain changed view fields and car upserts/removals. Separate `coordinates` messages carry buffered original source samples. Static geometry is not repeatedly transmitted. The former SSE endpoint is removed; there is no polling/SSE alternative.

The server owns playback/source/race decisions and the replay clock. A new `motionEpoch` invalidates old samples after play/pause, seek, speed changes, source/session changes or reconnection. Clients animate the API's playback anchor, bounded by its start/end and supplied coordinate coverage. They interpolate only between supplied source coordinates, applying the API's `rendering` policy. They never calculate gaps, tires, sector geometry or notification visibility, extrapolate car movement, or bridge source gaps.

Replay chunks cover approximately 2.5 seconds of wall-clock playback, scaled by speed, and refill before depletion. Live packets preserve native sample timestamps without the former 600 ms reduction, retain a small presentation buffer and stop at the latest received source sample. The server publishes changed metadata at up to 10 Hz for replay and coalesces live changes at up to 20 Hz. Actual rendering follows the client display's refresh rate, independent of packet cadence.

Clients acknowledge sequenced messages, synchronize clocks with ping/pong, and reconnect with a fresh ticket/snapshot after a disconnect. Queues and unacknowledged messages are bounded; slow clients are closed for explicit resynchronization. No lost upstream live samples are backfilled. Views remain ephemeral, and the shared F1 connection still requires an explicit REST connect command.

## Notifications and radio

View snapshots include the latest 80 matching events and their total count. `GET /views/{id}/events?offset=0&limit=80` provides pagination, with limit 1..100. It uses that view's time, driver and category filters. Track-wide events remain visible for selected drivers. Pre-race events can seek to replay start.

To select a supplied clip, `POST /views/{id}/radio` with `{ "action":"play", "clipId":"..." }`. This pauses that historical replay and selects radio in that view. Other actions: `{ "action":"pause" }`, `{ "action":"play" }`, `{ "action":"seek", "time":2.5 }`, `{ "action":"stop" }`. Audio state expresses client playback intent; the server does not produce sound or guarantee the client device played it.

Fetch MP3 bytes from `GET /media/radio/{clipId}` with bearer authentication. Both historical and live radio go through this route. Clip IDs are source/session scoped and must originate in supplied events. Arbitrary upstream URLs are never accepted. Live radio requires the server's saved F1 sign-in. Responses are bounded to 20 MiB. The web client fetches a Blob and plays a local object URL, allowing the bearer to stay in headers. Its audio buttons/seek slider call the radio API; media output remains local.

## Errors and client workflow

Errors use `{ "error": { "code": "...", "message": "..." } }`.

- 401 `API_UNAUTHORIZED`: missing/incorrect application token. Includes WWW-Authenticate: Bearer.
- 400 `INVALID_REQUEST`, 413 `BODY_TOO_LARGE`, 415 `JSON_REQUIRED`: invalid request.
- 403 `ORIGIN_NOT_ALLOWED`: browser origin not allowed.
- 404 `VIEW_NOT_FOUND`, `CLIP_NOT_FOUND`, `NOT_FOUND`: unknown/expired resource.
- 409 `F1_AUTH_REQUIRED`, `LOGIN_IN_PROGRESS`, `LOGIN_CANCELLED`, `REPLAY_NOT_READY`, `NO_CLIP_SELECTED`: explicit state conflict.
- 422 `F1_LOGIN_FAILED`: password sign-in failed. Does not invalidate the application's bearer token.
- 426 `HTTPS_REQUIRED`: non-loopback credentials need TLS.
- 429 `VIEW_LIMIT`, `STREAM_LIMIT`: bounded server capacity.
- 502 `UPSTREAM_FAILED`: provider/media failure without a raw response body.

A native client can use the complete workflow without loading any web page: authenticate requests; read system/races; create a view; subscribe; send view/playback commands; retrieve notifications/audio; sign into F1; explicitly connect; switch the view to live; explicitly disconnect/logout; delete the view. No terminal F1 login or browser-calculated business rules are required.
