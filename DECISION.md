# Decisions: 3D track and camera views

Recorded 20 November 2026. These decisions cover the 3D track and camera feature (branch `feature/3d-cameras`). Where this file and the existing [AGENT.md](AGENT.md) both apply, both hold. Nothing here relaxes AGENT.md's data, authentication or API-first rules.

## Data feasibility (measured against the free OpenF1 API)

Measured on Monza 2024 (session 9590), with Interlagos 2026 (session 11412) as a spot check. The free historical API serves both.

| Need | Finding | Consequence |
| --- | --- | --- |
| Car position | `location` x/y/z in approximately **decimetres**. Median sampling is 240 ms, p95 420 ms, max 800 ms. One LEC lap traces 5,734 m against Monza's official 5,793 m. | We can render at a real-world scale of 0.1 m per unit. This is approximate, not GPS. |
| Elevation | z varies by about 12.5 m across a Monza lap. | The 3D track and cars use the recorded z. |
| Heading | Not supplied. | Heading is derived for presentation only, from supplied samples around the presentation time. It is never extrapolated. |
| Track surface | Only a centerline exists. There is no width, kerbs, barriers or scenery. | A nominal-width ribbon is drawn around the recorded centerline (see D2). |
| Pit lane | Pit-stop traces leave the racing line by 12–19 m on a distinct path. | Pit-lane geometry comes from an actual pit-stop trace of the same session. |
| Lateral position | **All cars are snapped to a single line.** VER's lap is within 0.05 m (median, max 0.58 m) of LEC's. The front row on the grid is 9 m apart, almost entirely longitudinally. | Side-by-side cars overlap in 3D (see D1). |
| Telemetry | `car_data` gives speed, gear, rpm, throttle, brake and DRS at about 240 ms. | Used for the onboard HUD (M5). |
| Existing sampling | `compactLocations()` thinned samples to 800 ms (about 67 m apart at 300 km/h). | Full-rate samples are required (M0). The location cache is versioned, so old thinned files are not reused. |

## Owner decisions

- **D1 Overlapping cars: faithful, with ghosting.** Cars are drawn exactly on their recorded line. When cars overlap, they become semi-transparent so both stay visible. There is no invented lateral separation.
- **D2 Track dressing: ribbon, kerbs and pit lane.** This means a nominal 12 m asphalt ribbon following the elevated recorded centerline, red/white kerbs at aligned turn markers, the pit lane from a recorded pit trace, a start/finish line and a ground plane. The UI labels this as approximate. There is no generic scenery, barriers or run-off.
- **D3 Telemetry HUD: yes, as M5.** OpenF1 `car_data` loads as an optional source. A failure or delay never blocks the replay, and availability stays explicit. Values are sample-and-hold, the latest sample at or before presentation time, with no interpolation and no future values.
- **D4 Camera state lives on the server.** Window count, each window's mode, target driver and placed viewpoints are view settings, changed through `PATCH /views/{id}` and returned in snapshots, so native clients get the same contract. A drag stays local while it is in progress and is committed through REST when released. Tile maximize/layout is local presentation.
- **D5 three.js: exact-pinned npm dependency, served locally.** The server exposes only the three.js module build at `/vendor/three.module.min.js`, from `node_modules`. There is no CDN, and the CSP stays `script-src 'self'`. This is the project's second runtime dependency, after `ws`.
- **D6 Layout: tiled grid inside the map panel.** The grid shows the 2D map plus 1–4 camera tiles, auto-laid out (1, 2, or 2×2 plus the map). Any tile can be maximized. The driver tracker and notebook keep their places.
- **D7 Live mode: same code, verified only against history.** The 3D views use the same API stream, so they work live once a reference lap exists. Live 3D behaviour is documented as unverified.
- **D8 Git: feature branch, one verified commit per milestone.** Work happens on `feature/3d-cameras`. Nothing is pushed and no PR is opened unless the owner asks.

## Engineering decisions (made autonomously)

- **E1 One WebGL renderer with scissor viewports.** All camera tiles share one scene and one GPU context. Each tile renders its own camera into its own rectangle, which avoids duplicating geometry and the browser's limit on WebGL contexts.
- **E2 Own camera controls.** We write our own small orbit/drag controller instead of three's `OrbitControls`, whose bare `'three'` import would need an inline import map. That would break `script-src 'self'` without a CSP hash.
- **E3 World mapping.** Session units are converted as world X = x·0.1, world Z = −y·0.1, world Y = (z − z_min)·0.1, all in metres. The scale is a measured approximation and is labeled as such.
- **E4 Presentation smoothing.** Camera heading and camera movement are damped on the client, which only affects drawing. Car positions still come only from interpolation between supplied samples, under the API `rendering` policy, with no bridging of gaps longer than `maxGapMs`.
- **E5 Low-poly procedural cars.** Each car is a simple team-colored procedural body with the driver's abbreviation. No third-party car models or liveries are used.

## Roadmap (value-driven milestones)

| Milestone | Value | How it is verified |
| --- | --- | --- |
| **M0 3D data foundation** (server) | Full-rate xyz samples, a pit-lane path, 3D geometry and the camera settings contract | Unit tests, API output on real Monza data, `npm run test:stream` |
| **M1 First 3D window** | Elevated track ribbon and moving team-colored cars, with an orbit/bird's-eye camera synced to the replay | Headless WebGL screenshots on real data. Car positions match the 2D map at the same render time. |
| **M2 Driver cameras** | Onboard (T-cam height) and chase camera for any car | Screenshots following a car through Monza's chicanes |
| **M3 Place cameras anywhere** | Trackside cameras placed from the 2D map or at a turn, with height and FOV, plus an auto TV director. Saved through REST. | REST round-trip tests and screenshots |
| **M4 Multi-window** | 2D map plus up to 4 independent camera tiles | Four-tile screenshots and a measured frame rate |
| **M5 Telemetry HUD** | Speed, gear, throttle, brake and DRS in onboard/chase tiles | Unit tests. Values match OpenF1 at the same timestamp. |
| **M6 Polish and docs** | Kerbs, sector tint, labels, README/API/STREAMING/VALIDATION updates | Full test suite and a visual review |

Status (20 November 2026): M0–M6 are implemented and verified on `feature/3d-cameras`; results are in [VALIDATION.md](VALIDATION.md).

Parallel tracks: the server work (M0, then M5's data loading) runs alongside the client work (M1, then M2/M3/M4). Integration is checked by the lead after each milestone.
