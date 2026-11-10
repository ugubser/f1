# Trusted LAN deployment — 10 November 2026

- Owner explicitly authorized HTTP F1 password submission on the trusted LAN. `F1_ALLOW_HTTP_LOGIN=1` enables this deployment option; the default still requires TLS for remote credentials. Forwarded headers do not authorize password transport, and application bearer authentication is unchanged.
- All 104 tests pass locally and on microserver (Node.js 22.23.2). A LAN HTTP check of the running service returns 401 for an unauthenticated login request, and 400 schema validation for an authenticated empty login body instead of 426. No F1 password or real login attempt was needed for this transport check. The existing saved F1 sign-in remains valid.
- The user opened TCP port 3000 in the firewall. Independent network requests reach the UI (200) at http://192.168.10.118:3000/. The enabled user service listens on `0.0.0.0:3000`; lingering enables startup without an interactive login. Code is under `~/apps/f1/current`, cache under `~/apps/f1/cache`, private credentials under `~/.local/share/f1-race-replay/`. No Caddy or changes to other services were needed.
- The base deployment is commit `6a31b6b`; the HTTP-login option is a subsequent local patch, also deployed. Deployment details are recorded in `~/apps/f1/DEPLOYMENT.md` on microserver. The follow-up HTTP-login option, its tests and deployment documentation are included in this change.

---

# UI environment configuration — 10 November 2026

- 103 automated tests pass on Node.js 26.8.1 and 22.23.2. New coverage checks private UI environment permissions and symlink rejection, parsing/invalid or absent configuration, the explicit public bootstrap allowlist, raw environment-file denial, and automatic bearer-authenticated connection on repeated client loads.
- `public/.env` was provisioned locally with the existing application token, mode `0600`, and verified ignored by Git. No credential rotation was performed. The bootstrap deliberately exposes the application credential to UI users, never F1 subscription tokens or other environment entries. All application REST endpoints still require bearer authentication.
- The running local server was restarted. Browser verification confirmed automatic connection before and after refresh, without a token input; the race calendar loaded through the authenticated API. Replay loading was also checked after automatic connection.
- No deployment, commit or push was performed for this change.

---

# Validation — 10 November 2026, buffered WebSockets (2.1)

- **100 automated tests pass on both Node.js 26.8.1 and Node.js 22.23.2**, tested locally. The latter matches the microserver's previously inspected runtime version; no code was deployed there.
- REST controls are retained. The former SSE route is removed. New tests cover bearer-protected, expiring single-use tickets; no pre-auth socket data; origin/query rejection; ticket reuse/expiry; unauthenticated timeout; metadata deltas; source/seek/speed epochs; coordinate buffering; ACK limits; sanitized errors and fresh same-view reconnect snapshots. Actual WebSocket wire messages conform to the declared native-client schemas.
- Deterministic 60 Hz presentation tests at **1x, 10x and 60x** match actual supplied fixture coordinates on every frame. Long gaps do not become invented movement; underruns stop at the supplied coverage limit; obsolete epochs are discarded. A separate test proves live positions less than 600 ms apart are retained.
- Real-data buffer benchmark: actual cached **Monza 2024 / session 9590**, isolated loopback API server, same MotionBuffer as the web client. Each speed ran for approximately six seconds, with **zero buffer underruns** and a distinct driver-81 position at every sampled frame. Node timer cadence was approximately 58 frames/second, not claimed to be a physical display measurement. REST control latency averaged approximately 3–4 ms per tested play command.

| Speed | Wall seconds | Replay seconds | Distinct position frames | Buffer underruns | Control ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1x | 6.01 | 6.01 | 347 | 0 | 3.2 |
| 10x | 6.01 | 60.05 | 350 | 0 | 3.9 |
| 60x | 6.01 | 360.89 | 348 | 0 | 3.4 |

- Browser checks with the real Monza race independently verified continuous presentation. At 1x: **83.870 wall seconds / 83.860 replay seconds / 5,030 draw frames**; 10x: **70.473 / 704.896 / 4,229 frames**; 60x: **31.249 / 1,875.240 / 1,875 frames**. Each sampled draw advanced presentation time (distinct-time frame counts equal draw counts), approximately **60 Hz** at all three speeds. Buffering was false at the recorded start/end samples. Pause, seek, driver selection and source restoration also passed. No browser console warnings/errors were observed.
- Browser Live F1 connected through the new downstream WebSocket stream with the existing saved sign-in, showing **22 cars** and the upstream ended-session waiting state. Switching to live cleared historical turn markers immediately; switching back restored the historical time/driver, paused. Active-race position cadence and upstream-to-screen latency cannot be measured from an ended session.
- Production F1 transport now uses the same pinned `ws` library for consistent private-header support on the supported Node runtimes. An actual authenticated connection with this implementation returned **waiting / Ends / 22 cars**. F1 tokens remain server-side; REST login/logout and application bearer access are unchanged. The owner had already confirmed a fresh subscription login through the v2 web/API form.
- Full numeric results are in [docs/stream-benchmark.json](docs/stream-benchmark.json); repeat with `npm run test:stream`. Socket bytes include initial snapshots/buffers. JSON is retained; binary encoding was unnecessary for this local workload. Live rendering adds a deliberate 300 ms source buffer, and never removes delay already present upstream.
- Local-only verification. Nightly reboot behavior, TLS/reverse-proxy deployment, performance on the microserver hardware and sustained active-session coverage remain separate deployment checks. Valid access/F1 tokens and caches persist; view IDs, sockets and motion buffers do not. Nothing was deployed, committed or pushed for this iteration.

---

# Validation — 10 November 2026, API-first v2

- All **84 automated tests pass** on Node.js 26.8.1. Existing race-rule, JWT/storage and SignalR checks remain; HTTP tests now target the bearer-protected v1 API. New service/transport/contract checks cover independent views/clocks, server-derived frames, cancellation, expiry, source-switch races, authentication and radio.
- Unauthenticated, incorrect-token and URL-token requests are rejected for application APIs, including legacy routes, F1 sign-in, media and SSE. Native requests work without browser-specific Origin/action headers; allowed browser preflight and rejected foreign origins are tested.
- F1 API password login, sign-in status, explicit connect, logout, concurrent login rejection, cancellation and logout-vs-save ordering pass with isolated fixtures. Invalid bodies and raw upstream errors do not echo passwords or F1 tokens. Application access key creation/storage rejects overwrite, symlinks and public permissions.
- OpenAPI response schemas are checked against real HTTP fixture responses for system, races, auth, live state, historical/live views, events, playback and radio. A separate structural check of actual provider responses (system, discovery, historical view and live view) also passed. The checker covers the schema vocabulary used in this contract; it is not a general OpenAPI linter or proof of every external SDK generator.
- API-only acceptance on the final local server loaded actual Monza 2024 with **20 cars, 3 sectors and 11 aligned turns**. It sought to 40%, selected driver 81/turn 6, read events, retrieved a **135,936-byte** radio clip through protected media, and proved a second view kept its independent time. No browser calculations were involved.
- The final local server started disconnected with the persisted sign-in still valid. An explicit API connect succeeded using the owner's existing saved F1 token: session status **Ends**, **22 drivers**, waiting for a live session. Disconnect and source restoration returned the historical view to its prior time, paused. This was **not a fresh email/password sign-in** and did not verify active-race streaming.
- Browser verification with actual Monza: load/seek, gaps/tires, driver selection, sector colors, named turns and turn selection worked through the new endpoints. Play/pause advanced/stopped the server clock. Switching to live showed the saved sign-in, explicit connect returned 22 cars, and returning to history restored the time/driver. Radio played from an authenticated Blob URL; pause, seek and close worked. No console warnings/errors were observed.
- The email/password form was additionally exercised against an explicitly isolated fixture server. It submitted through the login API, cleared the password field, showed signed-in/expiry status and left F1 disconnected until Connect. Logout returned to signed-out/disconnected. At **390 px** viewport width, the final login UI had no horizontal overflow (content 375 px); console warnings/errors were absent. No owner password was requested or submitted by the agent.
- The local application access key was provisioned privately outside Git, and the final API/UI is running at localhost:3000. Temporary browser-validation servers are removed after checks. Nothing was deployed to microserver, committed or pushed in this iteration.

## Remaining real-provider checks

- Completed after the v2 implementation: the owner confirmed a **fresh real-account API sign-in** through the new UI. This is owner-reported evidence; fixture login and agent-observed saved-token connection remain explicitly separate checks.
- Sustained active-session updates, circuit reconstruction after reconnect and all live message variants still need verification during an active F1 session. No missing live data is backfilled or replaced with another source.
- LAN TLS/reverse-proxy setup, microserver lifecycle and native application integration are outside this local iteration. Nightly restart behavior is defined and service state/expiry are tested; the host's actual shutdown schedule has not been changed or exercised.

---

# Validation — 10 November 2026, F1 connection setup fix

- Reproduced the signed-in connection failure without logging the subscription token, cookie values or connection identifiers.
- F1's OPTIONS bootstrap returned HTTP 405 with AWSALB/AWSALBCORS cookies. The following authenticated POST succeeded with HTTP 200. The app incorrectly rejected the bootstrap before reaching that POST.
- Fixed handling of this specific affinity-cookie response. POST failures remain errors; authorization failures still stop retries. New errors identify the failed HTTP stage without exposing upstream response bodies.
- Added three regression tests: OPTIONS 405 with affinity succeeds, OPTIONS 405 without affinity stops, and POST 405 with affinity remains an error. All 62 tests pass.
- Authenticated direct WebSocket connection now succeeds with the saved sign-in, returning session 11412, 22 drivers and session status `Ends`. The idle state is shown as waiting for a live session, rather than claiming the map is building.
- The authenticated idle connection stayed established for 36 seconds with zero connection errors. After restarting the local server, browser verification showed “Connected to F1. Waiting for an active session”, 22 drivers and no console warnings/errors.
- Active-race position and map updates remain to be checked during a session. No credentials needed to be re-entered.

## Earlier validation — 8 November 2026, direct F1 live mode

- All 59 automated tests pass: 31 existing replay/timing tests and 28 new authentication, streaming, live-state and access-control tests.
- The current public F1 account script and F1 authorization-form preflight both returned HTTP 200. The client/policy configuration was discovered and the returned credential destination matched id.formula1.com. No account credentials were submitted.
- Tests verify PKCE/state checks, credential-origin restrictions, signed subscription JWTs, expiry, private token-file permissions, symlink rejection, non-interactive CLI refusal and suppression of sensitive upstream errors.
- Streaming tests verify authenticated negotiation/cookies, JSON handshake and subscription, split/coalesced frames, safe snapshots, authorization failure without anonymous access, reconnect snapshots, stale source data, logout, cancellation and authenticated radio proxying. A real local WebSocket handshake confirms the installed Node runtime sends custom Authorization/Cookie headers without token query parameters.
- State tests verify indexed/array partial updates, older-leaf rejection, prototype-key rejection, compressed UTC positions, tire stints, pit transitions, message corrections, session resets, a complete clean observed reference lap and independent gap freshness.
- HTTP tests verify same-origin actions, Origin/Host rejection, local-only policy, no HTTP password endpoint and generic live error responses. Historical HTTP/API tests still pass.
- Browser checks: Live F1 displays signed-out instructions and disables Connect until a token exists. Historical Monza loads all 20 cars; seeking to 40% gives 30:24 and the expected gaps. Switching to Live F1 and back restores that time, driver selection and the paused replay. No console errors were observed.
- Mobile live sign-in instructions were checked near 390px with no horizontal overflow. No password field is exposed in the dashboard; the signed-out Connect button is disabled.
- Authenticated F1 sign-in, upstream subscription entitlement, live position variants and sustained real-session coverage remain unverified until the owner signs in. Synthetic fixtures test the protocol; they are not a production source.

## Earlier validation — race timing addition

- All 31 automated tests pass: the previous 19 checks plus 12 timing/API tests.
- Timing tests cover P1/P2/P3 semantics, recorded totals, seeking in both directions, future-value exclusion, formation-lap exclusion, missing or malformed fields, stale samples, inactive cars, driver/rival position changes and lap-gap units.
- API tests verify available and empty timing responses, input validation, explicit upstream failure and continued access to race metadata.
- Monza 2024 returned 20,444 interval records. At 13:33:59 UTC, Perez in P2 had +2.937s in both columns; Piastri in P3 had +3.762s Ahead and +6.725s To P1. The small difference from adding P2/P3 intervals is retained from the asynchronous source.
- Browser checks: both columns populated for the racing field; selecting Piastri identified Perez as the car ahead, Verstappen as P1 and the sample timestamp. Seeking to the start cleared pre-race timing; seeking back restored the earlier readings. Play advanced recorded gap values. At 70% replay time the lapped cars displayed +1 LAP rather than invented seconds. Tsunoda's old timing was withheld.
- Responsive check near 390px: each driver has a labeled second line for Ahead and To P1, with no horizontal overflow detected. Desktop retains both as columns.
- Timing uses the last recorded source value, with a 15-second freshness limit. This is not a continuous timing estimate. Only Monza was checked end to end for the new timing view.

## Earlier validation — 8 November 2026, iteration 2

- Node.js 26.8.1: all 19 automated tests passed with `npm test`.
- Syntax checks passed for server.mjs, public/app.js, public/replay.js and track-names.mjs; `git diff --check` passed.
- Replay tests cover interpolation, stale/missing positions, coordinate filtering, future-lap exclusion and complete uninterrupted reference laps.
- New tests cover completed-lap tire age, prior tire use, stint changes, missing age/coverage, unfinished retirement laps, unequal sector boundaries, missing/inconsistent sector timing, telemetry gaps, marker projection and incompatible geometry, multi-car message attribution, future/other-driver exclusion, backward seeking, category filters, pit entry/exit disclosure, separately labeled stationary duration, invalid event dates and radio URL restrictions.
- HTTP tests cover static routes, method/input rejection, optional-source failure/empty/available states and circuit-provider failure. They use injected data loaders and do not depend on public API availability.

## Real-data checks

- Monza 2024 (session 9590): all 20 car trajectories loaded in the browser. Additional feeds returned 50 stints, 61 race-control records, 30 pit-lane visits and 60 radio clips; these normalize to 181 notebook events because pit entry and exit are separate.
- Monza's reference lap for car 16 was lap 33, with sector durations 27.189 / 28.364 / 27.673 seconds. All 11 MultiViewer markers aligned with the same-session trace; maximum projection error was approximately 37 coordinate units. The UI can choose another driver's complete lap as its reference (car 1, lap 43, in the checked load).
- Silverstone 2024 (session 9558): car 44 returned 8,352 compact position samples. Lap 45 supplied all three sectors; all 18 turn markers aligned. This was an API/geometry check, not a full-field browser replay.

## Browser checks

- Loaded Monza with all cars; inspected compound/age rows and sector colors, numbered turns, selectable details and source availability.
- Seeking to 40% reached lap 22 at 30:24 elapsed. Selecting Ricciardo showed the multi-car incident with Hulkenberg, investigations, penalties and pit entry/exit, without unrelated drivers' individual messages.
- Reaching the end showed Leclerc's hard tires at age 38 completed laps. Radio-only filtering showed five Leclerc clips. Pressing Listen opened the native audio player and playback began successfully.
- Closing radio, selecting its 43:14 event timestamp, and pressing play advanced the replay clock. Pause held playback. Source messages and tire state followed seeking backward.
- Sectors and Turns can be independently disabled; removing Turns also removes markers and disables the names switch. Names are shown in a clickable directory to avoid overlapping labels.
- Checked the responsive layout at approximately 390px, including map controls, turn names, notebook and driver tracker. No horizontal page overflow was detected. Desktop layout was inspected in the in-app browser.

## Limits

Only Monza was tested end to end with all drivers. Coverage for other tracks and seasons depends on both providers. Curated turn names cover Monza; other tracks may only have numbers. Approximate marker alignment is not a surveyed validation of circuit topology or minor layout revisions. Sector boundaries come from a single lap's timing, rather than official surveyed coordinates. Pit exit times are derived, not separate position observations. Missing optional feeds are reported individually. No live feed, video integration, account authentication, deployment or publication was added.
