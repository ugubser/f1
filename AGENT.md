# F1 Replay API

## Goal
API-first Formula 1 historical replay and direct F1 Live Timing for Urs. Web and future native clients use exactly the same bearer-protected API. Work locally until deployment is explicitly requested.

## Working conventions
- Project: /Users/ugubser/Documents/GitHub/f1. Node.js 22+, native ES modules. One pinned runtime dependency, `ws`, handles server and upstream F1 WebSocket protocol framing; install with `npm ci`.
- `npm run api:setup` provisions a private application token once; `npm run api:token` displays it only in an interactive terminal. Configure ignored `public/.env` with `F1_UI_API_TOKEN` matching the API token (mode `0600`), then `npm start`; `npm test`.
- `server.mjs` is HTTP transport and authentication; `openapi.mjs` is the versioned API contract.
- `providers.mjs` handles upstream historical requests and disk caching. `services/history.mjs` owns shared race loading, progress and geometry. `services/views.mjs` owns independent view state, replay clocks and derived frames.
- Pure race rules live in `domain/`. Browser code must not recalculate gaps, tires, sectors, turn alignment, notifications or source availability. The API owns the replay clock; clients may advance its supplied anchor for presentation and interpolate only supplied coordinate samples under the API rendering policy.
- The browser is a rendering/audio client of `/api/v1`. Every app action (including F1 login/logout, media controls, selections, filters and overlays) goes through REST. Buffered coordinates and state deltas use the documented WebSocket protocol. Layout, formatting, sample interpolation and drawing stay local. Never extrapolate positions or bridge long source gaps.
- Use actual data. Never substitute simulated positions, another source, anonymous authentication or an alternative login method. Tests can inject explicit fixtures; production cannot.
- Keep all drivers on one UTC axis. Never expose future events or interpolate long gaps. Missing and stale values remain explicit.
- API numeric timestamps are UTC milliseconds. Radio playback offsets are seconds. Gaps retain their unit, comparison drivers, source timestamp and freshness status.
- Historical geometry comes from a complete clean lap of that session. Coordinates are approximate, not GPS. Reject incompatible turn metadata.
- One shared F1 connection and account; independent per-client views. Switching sources or deleting a view must not disconnect other live clients. Connect only on explicit request, including after restart.
- `services/stream.mjs` issues 10-second, single-use, view-bound tickets through bearer-authenticated REST; the first WebSocket message authenticates with that ticket. No URL credentials or application data before authentication. No SSE/polling alternative. ACKs, sequence numbers, bounded buffers and fresh reconnect snapshots prevent stale backlogs.
- `public/motion-buffer.js` is presentation-only. Playback/source/seek changes invalidate old coordinate epochs. Replay prefetch is speed-scaled; live samples retain native timestamps without the old 600 ms reduction.
- Views expire after 30 minutes without requests and are not persisted across restarts. Datasets and stream counts are bounded. Disk caches and valid sign-in persist; live positions/reference laps do not.

## Authentication and credentials
- Every application API, including media, stream-ticket issuance and F1 login, requires an application bearer token. WebSocket upgrade is transport only; application streaming requires the first-message ticket derived from bearer authentication. Static UI files may be public. Legacy unversioned APIs are removed, never left as an unauthenticated alternative.
- Application access tokens and F1 subscription tokens are separate. Only the server retains F1 subscription tokens. Never put either token in URLs, tracked source, browser storage or Git. The user explicitly authorized an ignored UI `public/.env` containing the application token: startup reads it and `/ui-config.json` intentionally delivers only that browser-visible credential for automatic connection. Anyone with UI access can use this application token. Never expose an F1 subscription token through this configuration.
- The user explicitly authorized F1 email/password submission from UI to this API. Passwords are transient request data, forwarded only to the exact F1 identity provider over HTTPS; never persisted, echoed, logged or queued to disk.
- Local loopback HTTP is supported for development. Remote credential submission requires TLS by default. The owner explicitly authorized HTTP F1 login on their trusted internal network: enable it only with `F1_ALLOW_HTTP_LOGIN=1` in the deployment service. This affects browser-to-server transport only; upstream F1 sign-in remains HTTPS. Configure exact allowed browser origins; native clients do not require Origin headers.
- `f1-auth.mjs` verifies F1 JWT signatures and owns private atomic token storage. `services/account.mjs` owns API sign-in/logout and cancellation. A completed pending login must never resurrect a sign-in after logout.
- `f1-live.mjs` owns negotiation, framing, reconnects and sanitized snapshots; `live-state.mjs` merges timestamped source patches.
- Unexpected additional F1 verification must be reported explicitly. No password storage or automatic password-based re-login. No F1 refresh token is available in the implemented flow.
- Never expose raw upstream credential responses, body logging, credentials in console output, downloaded caches, machine settings or node_modules in version control.

## Validation
- Always add meaningful unit tests where possible. `npm test` covers pure rules, services, auth, HTTP/WebSocket contracts, bearer/ticket protection, buffering and media. `npm run test:stream` benchmarks actual Monza playback at 1x, 10x and 60x in an isolated local API process. It does not connect F1 or alter another client view.
- Use independent API calls to prove workflows work without the browser. Verify the web client separately with actual historical data. Clearly separate fixture login tests, saved-token live checks and real password submission.
- Document unverified real-session behavior. Never ask the owner to send passwords or tokens in chat.
