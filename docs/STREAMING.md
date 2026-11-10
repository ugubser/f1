# Buffered streaming protocol v1

REST remains the only control interface: login, live connect/disconnect, loading, playback, selection, filters, overlays and radio. The WebSocket carries application snapshots/deltas and coordinates; client messages are only authentication, ACKs and clock pings. This is the same protocol for web and native clients.

## Connect and authenticate

1. Bearer-authenticated `POST /api/v1/views/{id}/stream-ticket` with `{}` returns HTTP 201:

   ```json
   {"ticket":"<single-use credential>","expiresAt":1794326400000,"url":"/api/v1/socket","protocolVersion":1}
   ```

2. Open that relative URL with the origin's WebSocket scheme: ws for local HTTP, wss for HTTPS. The URL has no query parameters or credentials.
3. Within three seconds, send `{"type":"auth","ticket":"..."}`. The ticket expires after 10 seconds, belongs to that one view and is consumed once. No application messages are sent before successful authentication. REST auth and F1 subscription auth remain separate; F1 credentials never appear in this protocol.
4. Read the initial `snapshot`, then `state` deltas and `coordinates`. ACK every sequenced message after processing it: `{"type":"ack","sequence":1}`. ACKs are cumulative and ordered.

Maximum 24 sockets, including unauthenticated sockets, and 128 outstanding tickets per process. Invalid origins/query parameters are rejected at upgrade. Native clients need no Origin. Application data is authorized by a ticket derived from bearer authentication, rather than cookies, subprotocol credentials or long-lived URL tokens.

## Server messages

Machine-readable definitions are in `/api/v1/openapi.json`, `components.schemas` and `x-websocket`. Protocol messages use JSON text. Two sequence domains are deliberate: WebSocket `sequence` is contiguous per socket; `state.sequence` / `viewSequence` increases per view across REST and all sockets.

- **`snapshot`**: `{type, sequence, state}`. A complete View, including `motionEpoch`, settings, server-calculated metadata and initial geometry. This is sent at connection and whenever the motion epoch changes.
- **`state`**: `{type, sequence, epoch, viewSequence, serverTime, revision, changes, cars:{upsert,remove}}`. Merge `changes` into the View; merge each car patch by driverNumber and remove listed IDs. Preserve omitted fields. Ignore an obsolete view sequence (for example after a newer REST response). The geometry only changes when its revision changes. Event-list changes preserve the server-filtered notebook, including corrected notices and total count; pagination remains REST.
- **`coordinates`**: `{type, sequence, epoch, replace, from, until, latest, cars:[{driverNumber,points}]}`. Each point is `[UTC milliseconds,x,y,z]`. On `replace`, clear the coordinate buffer. Otherwise merge by driver and source timestamp; duplicate boundary points replace the same timestamp. Discard packets from any epoch other than the current authoritative View. `from`/`until` are replay coverage bounds; live uses null bounds and an actual latest source timestamp.
- **`pong`**: `{type:"pong",sentAt,serverTime}`. Not sequenced; used for clock synchronization.
- **`error`**: `{type:"error",sequence,code,message}`. Explicit `VIEW_NOT_FOUND` or `STATE_UNAVAILABLE`, followed by socket close. Upstream bodies/secrets are never returned.

Metadata updates are calculated only as needed: changed controls/loading state, live source revisions, 100 ms replay intervals while playing, and a two-second maintenance check. Coordinates refill independently when replay coverage falls below the threshold or new live samples arrive. Live arrivals are coalesced by a 50 ms scheduler; samples inside the batch are retained.

## Playback anchor and coordinate buffers

The View's `playback` values and `serverTime` define the authoritative anchor. Between messages, clients can advance its presentation time at the supplied speed, bounded by `playback.start/end` and the delivered coordinate coverage. Use a monotonic local clock. Synchronize its offset with JSON pings: `{"type":"ping","sentAt":<local monotonic milliseconds>}`; estimate server time at the midpoint of send/receive and prefer the lowest observed RTT sample. The web client pings on connection and every five seconds.

A new `motionEpoch` invalidates every prior coordinate packet. It changes on play/pause, seek/reset, speed changes, source/race/session changes and live connection generations/status transitions. REST responses also include the epoch, so a control acknowledgement can invalidate motion immediately. It is valid to briefly have no buffered coordinates until the matching packet arrives. Playback and source changes remain independent per client view.

Replay initially prefetches max(3 seconds of race time, 2.5 seconds × playback speed) ahead, bounded by race end, plus a predecessor sample for interpolation. It refills when less than 1.5 seconds of wall-clock playback remain. At 60x this is approximately 150 seconds of race-time coverage and a 90-second refill threshold. If a consumer falls behind, replace obsolete coordinate backlog with the current window. Do not transfer an entire race for every view or every animation frame.

If replay coverage runs out, freeze presentation at the coverage boundary and mark buffering; do not invent movement past it. Reconnect supplies the current authoritative anchor and a fresh window. Holding a presentation buffer does not pause the server's independent replay clock.

Live sends the last eight seconds of available samples initially, then only newer points per driver. The server no longer discards samples less than 600 ms apart. It retains at most 20 minutes / 12,000 points per driver. The presentation clock starts a small distance behind the latest actual sample (300 ms by default), advances at 1x and stops at the latest received timestamp. This buffer adds a small intentional rendering delay to smooth arrival jitter; it cannot remove delay already present in F1's feed. Inactive/stale/retired cars remain subject to the server's visibility state. Client-side sample freshness also uses the synchronized server clock, so a stalled live buffer cannot keep an old position looking current. No future positions are predicted.

The View supplies `rendering.maxGapMs`, `staleAfterMs` and `liveBufferMs`. Interpolate supplied coordinates only when the bounding source samples are within maxGapMs. A lone sample may be held at its exact known position, marked stale after staleAfterMs and hidden after maxGapMs. Never draw a path across longer gaps. This interpolation is presentation, not a second implementation of lap/gap/tire/notification rules. The browser's generic implementation is `public/motion-buffer.js` and can guide a native renderer.

## Reconnect and flow control

- Validate contiguous WebSocket sequence numbers. A gap requires reconnection/resynchronization, never guessing missing state.
- Acknowledge every sequenced packet after processing. The server closes consumers with 32 outstanding packets or more than 512 KiB already buffered for sending (1013). It does not silently discard notices to keep moving.
- Browser ACK/clock messages are limited to 2 KiB; binary/client control commands are rejected. Standard WebSocket ping/pong checks peers every 15 seconds.
- Reconnect using a new bearer-authenticated ticket. The fresh snapshot replaces the baseline and coordinate buffers. Do not treat `viewSequence` as an upstream event replay cursor.
- The web client clears motion on disconnect and makes five consecutive reconnect attempts without a received state, then asks the owner to reconnect. There is no SSE/polling fallback.
- Close codes: 4401 invalid/missing ticket, 4404 expired/deleted view, 1008 invalid protocol message, 1011 state failure, 1013 slow consumer. Deleted/restarted views must be recreated explicitly; the same application access token remains usable if unchanged.

Notifications remain recoverable within the server's bounded event history via `/views/{id}/events`. Reconnection does not reconstruct position/pit samples that never arrived from F1. Application keys, valid F1 sign-in and disk caches persist across nightly shutdown; live connection/buffers and view IDs do not.

## Verification

`npm test` covers tickets, authorization boundaries, epochs, deltas, raw live samples, long gaps, underruns, slow consumers and deterministic 60 Hz presentation at 1x/10x/60x. `npm run test:stream` runs actual Monza 2024 through an isolated local REST/WebSocket server and the same motion buffer, measuring playback advancement, distinct position frames, underruns, bytes and control latency. It uses real source data and does not connect to F1 or change another client's view.

Optional benchmark settings: `F1_BENCHMARK_SECONDS=6` (2..30 per speed) and `F1_BENCHMARK_OUTPUT=/absolute/path/report.json`. It can take several minutes to fetch an uncached race; cached runs start quickly. Node timer cadence is measured, not claimed to equal a physical display refresh rate. Active-session latency and actual device rendering require separate checks; see VALIDATION.md.
