# F1 Race Replay

## Goal
A local web application for Urs that replays actual historical OpenF1 car positions on a circuit map. Select a race by year, month and/or circuit, then play, pause, seek or adjust speed. Also provide an independent direct F1 Live Timing mode using the owner’s F1 TV subscription.

## Working conventions
- Project destination on Urs's Mac: /Users/ugubser/Documents/GitHub/f1.
- Node.js 22+, native ES modules, no mandatory npm dependencies. Run `npm start`; validate with `npm test`.
- Frontend lives in public/. Server proxies OpenF1, throttles requests and caches compact responses locally.
- Keep replay math independent of UI and transport in public/replay.js.
- Use real data. Never silently substitute simulated car positions; clearly report missing data and errors.
- Keep all drivers on one UTC time axis. Do not interpolate across long telemetry gaps or display retired cars as still racing.
- Track outline comes from a complete clean lap in the same session and coordinate system. Coordinates are approximate, not GPS or track limits.
- OpenF1 historical replay requires no F1 TV credentials. Direct F1 live timing uses a local terminal sign-in; passwords are never stored and verified subscription tokens remain outside Git and the browser UI.
- Keep the first version local; do not deploy or publish without a request.
- Never commit credentials, raw downloaded caches, node_modules or machine-specific settings.
- Run replay logic tests and server/API checks after relevant changes. Document verification limitations.

## Direct live mode
Live timing connects directly to F1 SignalR Core, not OpenF1 live or MultiViewer.
- `f1-auth.mjs` and `auth-cli.mjs` own terminal sign-in and private token storage.
- `f1-live.mjs` owns authenticated negotiation, framing, reconnects and safe browser snapshots.
- `live-state.mjs` merges timestamped patches and normalizes source data; `public/live.js` contains transport-independent live display logic.
- Never send credentials to an origin other than F1’s identity provider, expose tokens through HTTP, follow authentication redirects, or silently connect anonymously.
- Live HTTP access is loopback only; connection actions require same-origin checks and the application header.
- Initial snapshots do not invent observed pit/lap events. Session changes reset all live state. A map requires a complete clean lap captured in that session.
- Tests may use explicit protocol fixtures; production must never simulate or silently substitute a data source.
- Document that signed-in entitlement and sustained live coverage need verification with the owner’s account. Never request credentials in chat.
