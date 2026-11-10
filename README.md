# F1 / Replay API

An API-first Formula 1 dashboard with historical OpenF1 replay and direct F1 subscription live timing. The included web UI is a client of the same API intended for native applications.

## Start locally

Requires Node.js 22 or newer. Server and upstream F1 WebSockets use the pinned `ws` package; browsers use their native WebSocket API.

```bash
cd /Users/ugubser/Documents/GitHub/f1
npm ci
npm run api:setup
cp public/.env.example public/.env
chmod 600 public/.env
```

Provision the application access token once. In your own terminal, `npm run api:token` displays it. Set `F1_UI_API_TOKEN` in **public/.env** to that same application token, then run `npm start`. This machine's UI environment is already configured.

Open **http://localhost:3000**. The web UI connects automatically, including after refresh. A connection failure offers **Retry connection**; an invalid configuration must be corrected in `public/.env`, followed by a server restart. No token prompt or browser storage is used.

The server reads this UI environment at startup and serves only its application token through uncached `/ui-config.json`. Anyone who can load this UI can retrieve that token and use the API. This is the intended trusted-network configuration; `.env` keeps it out of Git, not secret from UI users. The raw `.env` file is never served. F1 subscription credentials remain server-only.

Choose a race and **Load race**. First downloads can take several minutes; repeat loads use the private local `.cache/` directory. Race filtering, loading, replay clocks, derived positions, gaps, tires, notifications and track preparation are server-owned. Play, pause, seek, speed, reset, driver/turn selection, notification filters, overlay settings and radio controls all use API operations.

## F1 sign-in through the API

Select **Live F1**. Enter your F1 email/password in the form and click **Sign in to F1**. The UI submits them to `/api/v1/f1/auth/login`, authenticated with your application bearer token. The server forwards them to F1's identity provider, verifies the returned subscription token and saves only that token privately outside the repository. No password is saved or returned. The UI clears its password input on submission.

Click **Connect to F1** to connect. Signing in, starting the app or selecting Live F1 does not connect automatically. **Disconnect** stops the shared connection and retains sign-in. **Sign out of F1** cancels pending sign-ins, disconnects and removes the saved token. The implemented F1 flow has no refresh token: sign in again through the same form/API after expiry. Unexpected additional verification is an explicit error.

Every client shares this one F1 account and live feed. Each client has an independent view: selecting historical replay or closing a view does not disconnect other clients. Historical replay requires no F1 sign-in.

The previous terminal `npm run f1:login`, `f1:status` and `f1:logout` commands remain available for manual account maintenance, but are not needed by any UI workflow.

## API for native clients

All endpoints are under `/api/v1` and require:

```http
Authorization: Bearer <application-access-token>
```

The application token is separate from F1's subscription token. Native clients never need or receive F1 tokens. Other clients can configure the same application token through their own environment/configuration; native clients can also use their platform credential store.

Retrieve the machine-readable contract at **`GET /api/v1/openapi.json`** with your bearer header. Its source is `openapi.mjs`. See [docs/API.md](docs/API.md) for full lifecycle, commands, streaming, errors and example requests.

| Endpoint | Purpose |
| --- | --- |
| `GET /system` | Capabilities and server restart identity |
| `GET /races?year=2024&month=9&circuit=39` | Server-filtered race discovery |
| `POST /views` | Create an independent history/live view |
| `GET`, `PATCH`, `DELETE /views/{id}` | Read, update or release a view |
| `POST /views/{id}/playback` | Play, pause, seek, reset, speed |
| `GET /views/{id}/events` | Paginated notifications with the view's filters |
| `POST /views/{id}/radio` | Select, play, pause, seek or stop audio |
| `POST /views/{id}/stream-ticket` | Issue a single-use WebSocket connection ticket |
| `GET /media/radio/{clipId}` | Authenticated MP3 response |
| `GET /f1/auth` | F1 sign-in status and expiry |
| `POST /f1/auth/login`, `/f1/auth/logout` | Email/password sign-in and sign-out |
| `GET /live`, `POST /live/connect`, `/live/disconnect` | Shared live connection |

WebSocket protocol: [docs/STREAMING.md](docs/STREAMING.md). REST remains the control interface; replay/live motion uses buffered coordinate chunks and metadata deltas. The web client draws between supplied samples at display refresh rate.

Legacy unversioned endpoints and the former SSE stream are removed. There is no unauthenticated API or silent data-source substitution.

## Storage and nightly shutdown

The server application access key and F1 subscription token are private files outside the project. The web UI has a separate ignored copy of the application key in `public/.env` (mode `0600`). On macOS: `~/Library/Application Support/F1 Race Replay/`; on Linux: `~/.local/share/f1-race-replay/`. The application key is `api-access.key`; the F1 token is `session.json`. These files must belong to the service user and have mode `0600`. They are private files, not an encrypted vault. Caches stay under `.cache/` and are ignored by Git.

Valid credentials and disk caches survive shutdown. Views are ephemeral and expire after 30 minutes without requests. Restart invalidates view IDs; clients recreate a view. No live connection starts until explicitly requested. Previous live positions and circuit references are not restored as current, and live gaps while the machine is off are not backfilled. The live map needs a new complete clean observed lap.

## Local development and future LAN deployment

The server binds only to `127.0.0.1` by default. `PORT=3001 npm start` changes its port. You can supply an application token of at least 32 characters through `F1_API_TOKEN` instead of the private file; never commit its value.

The app is deployed on microserver at http://192.168.10.118:3000/, listening on `0.0.0.0:3000` as the enabled `f1-replay.service` user service. API and UI share that origin; credentials are provisioned privately for the service user. Non-loopback password requests require TLS by default. The owner explicitly permits HTTP F1 login on this trusted internal network: the service sets `F1_ALLOW_HTTP_LOGIN=1`. Omit that setting to require TLS remotely. The browser-to-server hop then carries credentials without HTTP transport encryption; the server-to-F1 hop always uses HTTPS. `F1_ALLOWED_ORIGINS` is a comma-separated exact-origin allowlist for a separately hosted browser client. Native clients do not require Origin headers. The inbuilt web UI uses its own origin; its CSP intentionally does not allow arbitrary external API servers. A future TLS reverse proxy must be configured explicitly; forwarded headers are not blindly trusted.

## Validation

```bash
npm test
npm run test:stream
node --check server.mjs
node --check public/app.js
```

See [VALIDATION.md](VALIDATION.md) for performed checks and real-provider limits. API/service tests use explicit isolated fixtures. Production always uses real sources.

## Data and limits

Gaps are independently recorded Ahead and To P1 values, not sums of asynchronously sampled rows. Unknown, changed-comparison or stale values are withheld. Tire age is completed laps on a set, including prior use; fitting times have lap precision. Positions disappear when samples stop. Missing feeds remain explicit.

The map is approximate session XY geometry, not GPS or track boundaries. Recorded sector durations split a complete clean lap. Historical turn markers come from MultiViewer and must align with that session. Curated Monza names are maintained separately. The direct live feed does not supply turn markers. Radio is only the selection supplied by the source. Video is outside this version.

Historical data: [OpenF1](https://openf1.org/docs/). Circuit markers: [MultiViewer](https://multiviewer.app/). Curated names: [Monza](https://www.monzanet.it/en/circuit/). Direct live mode uses F1 consumer endpoints through your subscription; these can change. Unofficial project, not affiliated with Formula 1.
