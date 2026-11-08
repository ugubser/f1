# Validation — 8 November 2026

- Node.js 24: all six automated tests passed (replay logic and local HTTP routes).
- Syntax checks passed for server.mjs and public/app.js.
- Real OpenF1 integration: 2024 calendar returned 24 races; Monza (session 9590) returned 20 drivers, 1,009 lap records and 482 classification-change records.
- Leclerc's position response produced 7,607 compact samples. A complete lap reconstructed an 88-point circuit outline.
- Browser check: all 20 driver trajectories loaded successfully. Play advanced the clock; pause held it. Seeking to 40% showed lap 22 at 30:24 elapsed. Driver highlighting and combined September/Monza filters worked.
- Only Monza 2024 was checked end to end. Other circuits/years depend on OpenF1 data completeness. Mobile layout has responsive rules but was not separately exercised on a mobile browser.
- No live feed, F1 account authentication or hosting deployment is implemented.
