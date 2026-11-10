# F1 / Race Replay

A local Formula 1 dashboard with direct F1 subscription live timing and historical replay: choose a season (2023 onwards), month and/or circuit, load a race, then follow the recorded cars on a reconstructed circuit map. Includes playback controls, driver gaps to the car ahead and P1, tire compound and age, replay-timed notifications, color-coded sectors and interactive turn markers.

## Start on your Mac

Requires **Node.js 22 or newer** (no packages to install).

```bash
cd /Users/ugubser/Documents/GitHub/f1
npm start
```

Open **http://localhost:3000**. The initial selection is **2024 Monza**. Click **Load race**, wait for all cars, then **▶**. An internet connection is required for uncached races. The first download can take several minutes; repeat loads use the local `.cache/` directory. The app loads actual recorded positions, never simulated cars.

If you received this as a ZIP, copy the contents of its `f1` folder into your existing project folder, including the hidden `.git` and `.gitignore`. It already contains an initialised Git repository. You can instead initialise a fresh repository with `git init -b main` if you prefer not to copy `.git`.

Use `PORT=3001 npm start` for another port. The server binds only to localhost.

## Direct F1 live timing

Historical replay stays available without an F1 account. For live timing, sign in
securely in your own terminal:

```bash
npm run f1:login
```

The password prompt is hidden. Credentials go only to F1 over HTTPS; only a
short-lived subscription token is saved privately outside the project. Return to
[the local app](http://localhost:3000), choose **Live F1**, then **Connect to F1**.
Use `npm run f1:status` to check sign-in and `npm run f1:logout` to remove the token.
Repeat sign-in when the token expires. Do not send credentials or tokens in chat.

Live mode includes timing gaps, tire data, recorded positions and notifications.
Its map waits for a complete clean lap captured after joining. Switching back
restores the historical race, time and selected driver. There is no automatic
source substitution. See [secure setup and live limitations](docs/LIVE_F1.md).

## Explore a historical race

- **Ahead** shows the recorded interval to the previous race position; **To P1** shows the total gap to the leader. Both follow play, pause and seeking. P1 is the zero reference; lapped gaps stay in laps. Missing, updating or stale values show a dash. Hover a row, or select a driver, for its comparison drivers and recorded time. The two recorded fields can differ slightly from summing displayed intervals because updates are asynchronous.
- Every driver row shows compound (S/M/H/I/W) and age in completed laps on the set, including prior use. Tire changes have lap precision. Unknown data is marked explicitly.
- Select a driver to highlight their car and filter the **Race notebook**. Its race-control notices, pit-lane entries/exits and radio clips follow the replay clock. Track-wide notices are included. **Show all drivers** returns to the whole field.
- Switch notification categories on or off. Click an event timestamp to pause and seek to that moment. **Listen** plays the selected radio clip and pauses the replay; seeking stops the clip.
- Toggle **Sectors** and **Turns** independently. Select a numbered turn for details, or enable **Turn names** for a clickable directory. Turn names also appear on hover/focus. Curated names currently cover Monza; other tracks use supplied names or numbers.
- Source counts, missing feeds and incompatible turn geometry are reported next to the relevant view. Video is not part of this iteration.

The interaction concept, source contracts and coverage limits are documented in [docs/REPLAY_CONTEXT.md](docs/REPLAY_CONTEXT.md).

## How it works

- `/api/races?year=2024`: completed Race sessions from OpenF1 (not sprints).
- `/api/race?session=9590`: drivers, lap records and recorded classification changes.
- `/api/timing?session=9590`: recorded OpenF1 intervals and leader gaps, with explicit available/empty coverage.
- `/api/insights?session=9590`: tire stints, race control, pit visits and team radio, with separate available/empty/error states for each source.
- `/api/circuit?session=9590`: MultiViewer turn markers requested for the session's circuit and season, enriched with verified names where maintained.
- `/api/trajectory?session=9590&driver=16`: timestamped coordinates for one driver, compacted to approximately one sample per 0.8 seconds; UI interpolates short gaps.
- A complete, quick non-pit-out lap defines the circuit outline. All cars use the same session's original XY coordinates.
- Recorded sector durations divide that reference lap into three colored paths. Missing or inconsistent timing leaves sectors unavailable. Turn markers are checked against the lap; an incompatible marker set is not displayed.
- One UTC clock drives every driver. Lap-one start sets time zero. The timeline extends through the last available completed lap. Retired/stopped data disappears after five seconds without samples. A driver with no samples at the current time is dimmed in the table; this is not an official retirement classification.
- API requests are queued, throttled and retried on rate limits. Successful non-empty responses are cached with gzip; cache is intentionally excluded from Git and the distributed ZIP.
- Year/month/circuit filter the available races together; month follows the session's UTC date.

## Validation

```bash
npm test
node --check server.mjs
node --check public/app.js
```

Tests cover shared-clock interpolation, stale/missing data, future-lap/event exclusion, tire age and stint changes, retirement laps, sector splitting, turn alignment, multi-car notice attribution, radio URL validation, pit-duration timing, optional-source failures, interval/leader-gap timing, stale samples, changed rivals, lap-gap units and HTTP routes. See VALIDATION.md for the checks performed on this version.

## Limits and future work

OpenF1 is unofficial. Historical data from 2023 is free; recent/live data may require a separate paid OpenF1 account. Historical replay does not use an F1 TV subscription. API availability, fields and rate limits may change. Live mode connects directly to F1 using your subscription; historical mode continues to use OpenF1.

Positions are approximate: no accurate lateral placement, track boundaries or overtaking-line detail. The map is a lap trace, not a surveyed track plan. Track changes are handled by deriving geometry for each selected session. Race red flags, gaps and delayed samples can create periods without movement. Driver labels can overlap in a pack; click a driver for emphasis. Fonts use an optional Google Fonts stylesheet with local fallbacks.

Sector boundaries inherit approximate lap timestamps and compacted telemetry. MultiViewer markers are manually created and can have an older reference year, shown in the UI. Tire fitting is not timestamped; the table uses stint lap boundaries. Radio is a selection of communications, with significantly reduced coverage from 2026 according to OpenF1. Notebook times inherit source delays and corrections. Pit exit time is derived from the pit record timestamp plus lane duration; stationary time is separately shown only when supplied.

The direct live source handles authenticated SignalR snapshots and partial updates, expiry, reconnects and stale data. It does not synchronize video or automatically switch sources. Historical replay does not reproduce the original arrival order of partial records.

Data: [OpenF1](https://openf1.org/docs/), [MultiViewer](https://multiviewer.app/) and the [official Monza circuit guide](https://www.monzanet.it/en/circuit/). Unofficial project, not affiliated with Formula 1.
