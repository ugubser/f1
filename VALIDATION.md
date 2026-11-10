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
