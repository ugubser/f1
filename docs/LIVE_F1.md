# Direct F1 live timing

The app has two independent sources. **Historical replay** keeps the existing
OpenF1 race selection, playback, seeking and cached data. **Live F1** connects the
local Node server directly to F1's authenticated SignalR Core timing service.
No MultiViewer installation or OpenF1 live subscription is used for this connection.

## Secure sign-in

In your own terminal:

```bash
cd /Users/ugubser/Documents/GitHub/f1
npm run f1:login
```

Enter your F1 TV account email and password at the prompts. The password is hidden,
is never saved, and is sent only to `https://id.formula1.com` over HTTPS. Do not
put it in a command argument, `.env`, source file or this chat. The sign-in command
requires an interactive terminal and deliberately does not accept credentials
from environment variables or command arguments.

On success, open http://localhost:3000, choose **Live F1**, and click **Connect to
F1**. The page checks local sign-in automatically, so restarting the app after
sign-in is unnecessary. Connect is disabled until a usable token is present.
Your subscription's entitlement is ultimately checked by F1 when connecting.

On this Mac the token is stored at:

```text
~/Library/Application Support/F1 Race Replay/session.json
```

The application folder has mode `0700`; the token file has mode `0600`. The token
is signed by F1 and its signature is verified before saving. It is a private file,
not a macOS Keychain entry or an encrypted application vault. It remains a
credential: do not share or copy it. The file is outside the repository, and
credential-like files and HTTP captures are additionally ignored by Git.
No password, access-token response or authentication cookie is stored. Only the
subscription token and its expiry are retained. HTTP responses to the dashboard
never include that token.

Check local sign-in without showing the token:

```bash
npm run f1:status
```

Remove the saved sign-in:

```bash
npm run f1:logout
```

Disconnect stops the live connection but retains the local sign-in. Logout removes
the token; an open live view detects its removal and disconnects. This does not
sign you out of F1's own apps or revoke the token remotely.

F1 does not currently issue a refresh token for this flow. When the saved token
expires or F1 rejects it, repeat `npm run f1:login`, then reconnect. Passwords are
not retained for automatic re-login. Accounts requiring an additional interaction
that this sign-in flow does not support receive an explicit failure; no alternative
login method or anonymous connection is attempted.

## What live mode displays

- Driver classification, independently timestamped Ahead and To P1 gaps, tire
  compound and total laps on the tire set, and reported completed driver laps.
- Actual F1 XY positions. Cars with retired/stopped flags are removed from the
  live map; position samples older than five seconds disappear.
- Race-control messages and pit-entry/exit transitions received while connected.
  Initial snapshots do not invent pit visits. Radio clips, when supplied, play
  through an authenticated local server route, keeping the token out of the URL.
- Session state, track status, connection state and UTC clock. Gap values older
  than 15 seconds are withheld independently. There is no estimated substitute.

Unlike historical replay, the live view follows the incoming session and does
not offer play, pause or seeking. Live notebook timestamps are UTC and are not
seek buttons. Switching to Historical replay disconnects the live stream and
restores the previously loaded race, time and driver selection, paused.

## Live map and sectors

A live outline is reconstructed only after the app has observed a complete,
clean lap in the connected session. Joining mid-lap usually means waiting for
one further full lap. Driver timing remains usable while the map is waiting.
No historical geometry or simulated positions are automatically substituted.

The outline uses observed lap-completion timestamps and the reported last-lap
and sector durations. These timestamps are approximate and sector messages may
arrive late. The app waits for matching records, rejects interrupted/pit laps
and long position gaps, and only colors sectors when their timing is complete.
Turn-number/name metadata is not supplied by this live feed; those overlays
remain available in historical mode through the existing circuit source.

## Connection and authentication implementation

- Public login configuration is discovered from F1's account frontend.
- Sign-in uses the F1 identity provider's authorization-code + PKCE flow, with a
  random verifier, S256 challenge, state and nonce. Credential submission is
  restricted to the exact F1 identity-provider origin. Redirects are not followed.
- The resulting subscription JWT is verified using F1's public signing keys.
  Tokens without a usable future expiry are rejected.
- Live negotiation sends authenticated OPTIONS and POST requests to
  `https://livetiming.formula1.com/signalrcore/negotiate`, preserving the server's
  affinity cookie. F1 currently returns HTTP 405 for the OPTIONS bootstrap while
  setting `AWSALBCORS`; that specific response is accepted only with the required
  cookie. The authenticated negotiation POST must still succeed. The server opens `wss://livetiming.formula1.com/signalrcore`
  with private Authorization/Cookie headers, not a token in the URL.
- The client performs the JSON SignalR handshake and subscribes to the topics
  used by the UI. It parses split/coalesced frames, merges indexed partial
  updates using per-field timestamps, and inflates compressed positions with
  an output-size limit. Initial subscription snapshots and stream updates are
  handled separately.
- A lost connection retries with bounded backoff. Every reconnect requests a
  fresh subscription snapshot. Five consecutive failures stop automatic attempts.
  Authorization failure stops retries immediately and asks for sign-in.
- Source data that stops advancing is explicitly marked stale. A session-key
  change clears previous drivers, positions, events and map references.
- Live HTTP routes require loopback access and a valid local Host. Mutation
  requests also require the exact same Origin and an application action header.
  Cross-origin live requests are rejected; no CORS access or HTTP password form
  is provided. Running the historical app on a LAN does not expose live access.

## Verification and limits

Automated tests cover authentication, token storage, local access controls,
SignalR framing and negotiation, reconnects, compressed positions, partial and
out-of-order updates, session resets, live map reconstruction and gap freshness.
Protocol tests use clearly synthetic fixtures and mocked upstreams; the production
app has no simulated-data mode.

An authenticated direct connection was verified on 10 November 2026 using the
owner’s saved sign-in. F1 returned an ended session and 22 drivers. Active-session
position updates, every real-world message variant and video synchronization
still require verification during a session.
The sign-in configuration endpoint was checked without submitting credentials.
F1 can change its private consumer endpoints or refuse access. Live failures are
reported explicitly while historical replay remains separately selectable.

Sources checked 8 November 2026:

- [FastF1 authentication flow](https://github.com/theOehrly/Fast-F1/blob/main/fastf1/internals/f1account/login.py)
- [FastF1 authentication configuration discovery](https://github.com/theOehrly/Fast-F1/blob/main/fastf1/internals/f1account/discovery.py)
- [FastF1 account documentation](https://github.com/theOehrly/Fast-F1/blob/main/docs/api_reference/accounts_auth.rst)
- [FastF1 live SignalR client](https://github.com/theOehrly/Fast-F1/blob/main/fastf1/livetiming/client.py)
- [FastF1 timing and position parsing](https://github.com/theOehrly/Fast-F1/blob/main/fastf1/_api.py)
