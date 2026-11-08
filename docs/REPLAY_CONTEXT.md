# Replay context: interaction concept and data coverage

The driver tracker is the permanent overview: position, driver, tire compound,
completed laps on that tire set, and current lap. Compound colors are accompanied
by letters, so color is never the only way to identify a tire. A small dot marks
notifications within the last minute of replay time, including track-wide messages.

Selecting a driver highlights their car and filters the race notebook below the
map. The notebook keeps race-control notices, pit visits and radio together,
with category switches. Track-wide messages remain visible in a driver's notebook.
“Show all drivers” returns to the field view. Timestamps pause and seek the replay;
only events reached by the replay clock are shown. Up to 80 recent matching
entries are displayed. Pre-race events are retained with negative times; their
seek action goes to the beginning of the race replay.

Radio plays only after pressing Listen and pauses the replay. Seeking, changing
drivers, changing notification filters or loading another race stops the clip.
Playback failure is reported. There is no automatic audio or invented transcript.

Three fixed sector colors identify physical sectors, not fastest-sector results.
Their split positions come from the reference lap's recorded sector times and
interpolated positions. The map layer can be switched off. Numbered turn buttons
are available by default. Selecting or focusing a turn reveals its name; the
Turn names switch opens a clickable directory below the map. This keeps closely
spaced chicane labels readable on smaller screens.

## Data contracts

| Information | Source | Precision and coverage |
| --- | --- | --- |
| Tire compound / age | OpenF1 `stints` plus `laps` | Starting age plus completed stint laps. Tire fitting has lap precision, not an exact timestamp. Used sets include their starting age. Missing ages stay unknown. An unfinished retirement lap adds no age. |
| Driver notices | OpenF1 `race_control` | Includes flags, penalties, investigations, deleted laps and session notices. Many multi-car incidents have no driver field; explicit car numbers in the message associate them with each driver. Source text is preserved. |
| Pit notifications | OpenF1 `pit` | Entry at the record timestamp, exit derived by adding `lane_duration`. Lane duration is displayed only at exit. `stop_duration`, when supplied, is separately labeled as stationary time. |
| Radio | OpenF1 `team_radio` | Selected clips rather than complete communications. Coverage varies; OpenF1 reports substantially reduced coverage from 2026. No transcript is supplied by this endpoint. |
| Sector overlays | OpenF1 lap sector durations and same-session telemetry | Approximate boundaries from one complete, uninterrupted non-pit-out lap. No equal-length or equal-time sector substitutes. |
| Turn numbers / locations | MultiViewer circuit API, requested by circuit key and season | Manually created approximate markers. The provider can return an older reference year, which is shown. Markers are projected onto the session lap only if every marker fits within 2.5% of its bounding-box diagonal. Incompatible sets are not displayed. |
| Turn names | Provider name when supplied; curated official Monza names | Numbered turns work wherever metadata fits. Curated names currently cover Monza. Other unnamed turns explicitly say “Name not supplied.” |

Optional feeds have separate available, empty and error states. A failed radio or
turn-marker source does not turn valid car positions into a failed replay. The UI
reports the missing source; no simulated data, alternate providers or fabricated
markers are substituted. Missing sector timing leaves the measured outline
uncolored.

The pit exit timestamp is derived from the source's pit record timestamp and lane
duration, not a separate observed exit sample. Notification and lap timestamps
inherit OpenF1's precision and delays. Historical source records can contain
corrections; this interface does not reconstruct their original publication order.

## Sources checked 8 November 2026

- [OpenF1 endpoint documentation](https://openf1.org/docs/)
- [FastF1's MultiViewer request implementation](https://github.com/theOehrly/Fast-F1/blob/master/fastf1/mvapi/api.py)
- [FastF1's circuit marker interpretation](https://github.com/theOehrly/Fast-F1/blob/master/fastf1/mvapi/data.py)
- [Official Monza circuit guide](https://www.monzanet.it/en/circuit/)

Video was investigated: OpenF1 has no race-video endpoint. F1 TV separately
provides replays and onboard coverage, subject to its subscription and regional
availability. Video integration and video links are excluded from this iteration
at Urs's request.
