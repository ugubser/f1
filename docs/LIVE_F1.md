# Direct F1 live timing

Live F1 connects the Node server directly to F1's authenticated SignalR Core feed. Historical replay remains an independent OpenF1 source. The web and native clients use the same API.

## Sign in

First provision application API access with `npm run api:setup`, display that application token in your own terminal with `npm run api:token`, and connect the web client at http://localhost:3000.

Select Live F1, enter your F1 email/password, and click Sign in to F1. This invokes the bearer-protected `POST /api/v1/f1/auth/login`. The server forwards credentials only to F1's exact identity-provider origin over HTTPS, verifies the returned subscription JWT and saves the subscription token privately outside the repo. Passwords are never persisted, returned or logged. The UI clears its password field after submission. For LAN deployment, transport to the API must also use HTTPS.

Only status/expiry reaches clients. The application bearer token and F1 subscription token are distinct. The web browser keeps the application token in memory only; F1 tokens stay server-side. Native clients should keep application tokens in their OS credential store.

Sign-in does not automatically connect to F1. Click Connect to F1, or `POST /api/v1/live/connect` with `{}`. Connection/entitlement results arrive through the view stream or `GET /api/v1/live`. Disconnect retains sign-in; Sign out of F1 cancels pending sign-ins, disconnects and removes the saved token. No refresh token is available in the implemented flow, so repeat the UI/API login after expiry. Unexpected additional verification is an explicit error; no alternative login or anonymous source is attempted.

The previous terminal account commands remain optional manual maintenance tools; neither web nor native workflows depend on them.

## Live behavior

- One shared account and live connection; independent client views. Changing a view to historical does not disconnect other clients.
- No connection starts automatically, including on reboot. Valid saved credentials/cache persist; live positions, reference geometry and ephemeral views do not.
- Sign-in token file: `~/Library/Application Support/F1 Race Replay/session.json` on macOS; `~/.local/share/f1-race-replay/session.json` on Linux. Parent is mode 0700, file 0600, outside Git. This is a private file, not an encrypted vault.
- Driver positions, recorded Ahead/To P1 gaps, tire age, session/track state, race control, observed pit transitions and selected radio clips are normalized server-side.
- The live map waits for a complete clean lap captured after connecting. It never borrows historical geometry or invents missing positions. Live turns are unavailable because this feed does not supply them.
- Initial snapshots do not invent observed pit visits. Source/session changes reset old data. Missing/stale positions and gaps remain unavailable. No video synchronization or live backfill is implemented.

## Upstream protocol

Public F1 frontend configuration discovery; identity-provider authorization code + PKCE/state; verified RS256 subscription JWT. Direct timing negotiation authenticates OPTIONS, POST and WebSocket requests. F1's OPTIONS bootstrap currently returns HTTP 405 while setting ALB affinity cookies; only that exact cookie-bearing bootstrap response is accepted. POST negotiation still must succeed. Subscription/F1 tokens are private headers, not URL values. The transport's connection identifier is separate.

SignalR JSON framing handles split/coalesced frames, initial snapshots, timestamped indexed partial updates and bounded compressed positions. Reconnect requests a fresh snapshot. Authorization rejection stops retries; transport failures use bounded backoff. See `f1-live.mjs`, `live-state.mjs` and [API.md](API.md).

## Validation limits

Protocol and password API tests use explicit isolated fixtures. An actual saved-token connection was previously verified on this Mac, returning an ended session and 22 drivers. The owner subsequently confirmed a fresh subscription login through the v2 UI/API form. Downstream streaming now uses authenticated WebSockets with a small source-position buffer; see STREAMING.md and VALIDATION.md for the current protocol and checks. Real password entry belongs to the owner; tests must not falsely represent a fixture login or saved-token check as a fresh real-account password sign-in. Sustained active-race behavior still needs verification during a session.
