# F1 Race Replay

## Goal
A local web application for Urs that replays actual historical OpenF1 car positions on a circuit map. Select a race by year, month and/or circuit, then play, pause, seek or adjust speed. Later add live OpenF1 behind the same playback interface.

## Working conventions
- Project destination on Urs's Mac: /Users/ugubser/Documents/GitHub/f1.
- Node.js 22+, native ES modules, no mandatory npm dependencies. Run `npm start`; validate with `npm test`.
- Frontend lives in public/. Server proxies OpenF1, throttles requests and caches compact responses locally.
- Keep replay math independent of UI and transport in public/replay.js.
- Use real data. Never silently substitute simulated car positions; clearly report missing data and errors.
- Keep all drivers on one UTC time axis. Do not interpolate across long telemetry gaps or display retired cars as still racing.
- Track outline comes from a complete clean lap in the same session and coordinate system. Coordinates are approximate, not GPS or track limits.
- API has free historical data from 2023. No F1 TV credentials required. Paid OpenF1 credentials for future live mode stay on the server, outside Git.
- Keep the first version local; do not deploy or publish without a request.
- Never commit credentials, raw downloaded caches, node_modules or machine-specific settings.
- Run replay logic tests and server/API checks after relevant changes. Document verification limitations.

## Future live mode
Add a source adapter for OpenF1 MQTT/WebSocket messages. Handle `_key` upserts, incremental laps, token expiry, reconnects, stale data and HTTP backfill. The historical replay provides completed data and cannot fully test live arrival ordering.
