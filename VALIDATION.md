# Validation — 8 November 2026, iteration 2

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
