# F1 / Race Replay

A local historical Formula 1 replay: choose a season (2023 onwards), month and/or circuit, load a race, then follow the recorded cars on a reconstructed circuit map. Includes start/pause, seeking, restart, playback speeds and a selectable driver tracker with recorded positions and lap counts.

## Start on your Mac

Requires **Node.js 22 or newer** (no packages to install).

```bash
cd /Users/ugubser/Documents/GitHub/f1
npm start
```

Open **http://localhost:3000**. The initial selection is **2024 Monza**. Click **Load race**, wait for all cars, then **▶**. An internet connection is required for uncached races. The first download can take several minutes; repeat loads use the local `.cache/` directory. The app loads actual recorded positions, never simulated cars.

If you received this as a ZIP, copy the contents of its `f1` folder into your existing project folder, including the hidden `.git` and `.gitignore`. It already contains an initialised Git repository. You can instead initialise a fresh repository with `git init -b main` if you prefer not to copy `.git`.

Use `PORT=3001 npm start` for another port. The server binds only to localhost.

## How it works

- `/api/races?year=2024`: completed Race sessions from OpenF1 (not sprints).
- `/api/race?session=9590`: drivers, lap records and recorded classification changes.
- `/api/trajectory?session=9590&driver=16`: timestamped coordinates for one driver, compacted to approximately one sample per 0.8 seconds; UI interpolates short gaps.
- A complete, quick non-pit-out lap defines the circuit outline. All cars use the same session's original XY coordinates.
- One UTC clock drives every driver. Lap-one start sets time zero. The timeline extends through the last available completed lap. Retired/stopped data disappears after five seconds without samples. A driver with no samples at the current time is dimmed in the table; this is not an official retirement classification.
- API requests are queued, throttled and retried on rate limits. Successful non-empty responses are cached with gzip; cache is intentionally excluded from Git and the distributed ZIP.
- Year/month/circuit filter the available races together; month follows the session's UTC date.

## Validation

```bash
npm test
node --check server.mjs
node --check public/app.js
```

Tests cover shared-clock interpolation, stale/missing data, coordinate filtering, future-lap exclusion and circuit reconstruction. See VALIDATION.md for the checks performed on this version.

## Limits and future work

OpenF1 is unofficial. Historical data from 2023 is free; recent/live data may require a separate paid OpenF1 account. An F1 TV subscription is not used here. API availability, fields and rate limits may change. No live mode is implemented yet.

Positions are approximate: no accurate lateral placement, track boundaries or overtaking-line detail. The map is a lap trace, not a surveyed track plan. Track changes are handled by deriving geometry for each selected session. Race red flags, gaps and delayed samples can create periods without movement. Driver labels can overlap in a pack; click a driver for emphasis. Fonts use an optional Google Fonts stylesheet with local fallbacks.

A future live source should feed the same internal points interface, with incremental lap updates, MQTT `_key` upserts, credential management on the server, reconnect/backfill and buffering to align with video. Historical replay does not reproduce the original order in which partially completed records arrived.

Data: https://openf1.org/docs/ · Unofficial project, not affiliated with Formula 1.
