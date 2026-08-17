# Waste Management

Automated bin fill monitoring. A sensor in the bin lid measures how full it is,
and the admin gets a phone notification when it needs collecting — once, not
every reading.

**Zero npm dependencies.** The server uses only what ships with Node 22:
`node:sqlite` for storage, `node:http` for the API, `node:test` for tests.
Nothing to install, nothing to keep patched, no monthly bill.

## Try it now, with no hardware

The simulator produces realistic telemetry, so the whole system can be built
and demonstrated before buying anything.

```bash
cp .env.example .env
# set ADMIN_TOKEN in .env to any value you like

npm start                 # terminal 1
npm run simulate          # terminal 2
```

Then open <http://localhost:3000> and enter your `ADMIN_TOKEN`.

You will see the bin fill, alert once when confirmed full, and clear when
collected. The lines marked `SPIKE` are deliberate bad sensor readings — watch
them pass without triggering anything.

```
   374mm   82.6%  OK
   321mm   87.9%  OK
   190mm    100%  OK    SPIKE
   213mm   98.7%  OK
   214mm   98.6%  FULL  -> FULL
```

## The part that actually matters

Measuring distance is easy. Deciding a bin is *genuinely* full is not, and it
is where DIY bin monitors fail. Rubbish shifts, bags topple, and a stray echo
reads "full" for one cycle. Alert on raw readings and the admin gets pinged all
day, starts ignoring alerts, and the system is worse than useless.

Three mechanisms in [`src/fill.js`](src/fill.js) prevent that:

| Mechanism | What it does |
|---|---|
| **Median filtering** | The device takes 7 samples and sends the median, discarding outliers instead of averaging them in. |
| **Confirmation** | A level must hold above the threshold for N consecutive readings (default 3) before it counts. |
| **Hysteresis** | Once `FULL`, the bin only returns to `OK` below a much lower threshold (default 40%), so a bin sitting at the alert line cannot oscillate and re-alert. |

The gap between the two thresholds is a dead band: readings inside it confirm
nothing in either direction.

It also watches for the failure modes that make a fleet untrustworthy:

- **Offline detection** — a sensor that dies silently is worse than no sensor,
  because everyone assumes the bin is fine. Bins that stop reporting raise an
  alert of their own.
- **Battery** — reported with every reading, alerted once when low, re-armed
  only after real recovery.
- **Temperature** — bin fires are a genuine hazard; a high reading raises a
  warning.

Every one of these is covered by tests: `npm test` (35 tests, no network).

## How it fits together

```
  ESP32 + ultrasonic sensor          (deep sleep, wakes hourly)
            |  HTTPS POST  /api/v1/bins/:id/telemetry
            v
  Node server ── src/fill.js  ── pure decision logic
            |                     (level, confirmation, hysteresis)
            |── SQLite           ── bins, readings, events
            |── Telegram         ── admin push notification
            v
  Dashboard  /                     (fill meters, event log, mark collected)
```

| Path | Purpose |
|---|---|
| `src/fill.js` | Pure fill logic — no I/O, no clock. The heart of the system. |
| `src/alerts.js` | Persists readings and events, dispatches notifications. |
| `src/db.js` | SQLite schema and queries. |
| `src/routes.js` | HTTP API, auth. |
| `public/index.html` | Admin dashboard, no build step. |
| `firmware/` | ESP32 sensor firmware (PlatformIO). |
| `tools/simulate.js` | Fake telemetry for hardware-free development. |

Full diagrams live in [`docs/diagrams/`](docs/diagrams/) — use case,
architecture, flowchart, and data model. They render on GitHub.

## Alerting

Telegram by default: free, unlimited, instant, and it arrives as a real push
notification. SMS gateways charge per message and add up across a fleet.

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token
2. Message your new bot once, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your chat id
3. Put both in `.env`

Leave them blank and alerts print to the console instead — fine for
development. Delivery failures never block ingestion: the reading is still
recorded and the event still lands in the database.

## Calibration

Never hardcode bin geometry. Measure each bin once:

- `empty_distance_mm` — sensor-to-floor with the bin empty (the larger number)
- `full_distance_mm` — sensor-to-rubbish when you consider it full

Set them when registering the bin, or adjust later on the dashboard. Fill
percentage is derived from these, so recalibrating reinterprets readings
immediately.

**Mount the sensor centred in the lid**, not near a wall — the beam cone is
about 15° and will bounce off the side, reading "full" permanently.

## Tuning

Per-bin, all adjustable via `PATCH /api/v1/bins/:id`:

| Setting | Default | Notes |
|---|---|---|
| `full_threshold_pct` | 85 | Level that counts as full |
| `clear_threshold_pct` | 40 | Must drop below this to clear |
| `consecutive_required` | 3 | Confirmations before alerting |
| `repeat_alert_hours` | 12 | Reminder if still uncollected; 0 disables |
| `offline_after_hours` | 24 | Silence before an offline alert |
| `low_battery_v` | 3.4 | Suits a single 18650 |
| `high_temp_c` | 60 | Possible fire |

With hourly readings, `consecutive_required: 3` means a full bin alerts within
about three hours. Raise it if you get false alarms, lower it if alerts are too
slow. Note that consecutive genuine-looking spikes can bring an alert forward
by a reading or two — on-device median filtering is what keeps that rare.

## API

Device endpoint — authenticated with that bin's own device token:

```http
POST /api/v1/bins/:id/telemetry
Authorization: Bearer <device_token>

{ "distance_mm": 240, "battery_v": 3.9, "temperature_c": 24.5, "rssi": -63 }
```

Admin endpoints — `Authorization: Bearer <ADMIN_TOKEN>`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/bins` | List bins with live state |
| `POST` | `/api/v1/bins` | Register a bin; returns the device token **once** |
| `GET` | `/api/v1/bins/:id` | Bin detail plus recent readings |
| `PATCH` | `/api/v1/bins/:id` | Recalibrate or retune |
| `DELETE` | `/api/v1/bins/:id` | Remove a bin |
| `POST` | `/api/v1/bins/:id/collected` | Mark emptied by hand |
| `GET` | `/api/v1/events` | Alert history |
| `GET` | `/api/v1/health` | Public health check |

Each bin has its own token, stored only as a SHA-256 hash. One bin's token
cannot post as another, and unknown bin ids return `401` rather than `404` so
ids cannot be enumerated.

## Hardware

Roughly $28 per bin. Prices vary by supplier and region.

| Part | ~Cost | Notes |
|---|---|---|
| ESP32 dev board | $4 | WiFi built in, deep sleep ~15µA |
| JSN-SR04T ultrasonic sensor | $4 | Waterproof — the plain HC-SR04 dies from condensation |
| 18650 cell | $6 | Buy a reputable brand; fake cells are rampant |
| TP4056 charger (protected variant) | $1.50 | Get the one with over-discharge protection |
| IP65 junction box + glands | $9 | Water ingress kills more builds than anything else |
| 5W solar panel | $10 | Outdoor bins only |

Wiring (defaults in `firmware/src/config.example.h`): sensor `TRIG`→GPIO5,
`ECHO`→GPIO18, battery through a 2×100kΩ divider →GPIO34.

```bash
cd firmware
cp src/config.example.h src/config.h    # fill in WiFi, bin id, device token
pio run -t upload
```

The firmware measures before switching the radio on (WiFi's current surge skews
the ADC), sends the median of 7 samples, and deep-sleeps between readings. At
hourly readings one 18650 lasts months.

**No WiFi at the bin?** Don't put a cellular SIM in each unit — that is a
recurring per-bin cost forever. Use LoRaWAN and a single gateway. The API is
plain JSON over HTTPS, so a LoRaWAN webhook can post to the same endpoint.

## Off-the-shelf sensors

You do not have to build the hardware. Ready-made LoRaWAN nodes work with this
server via a webhook that forwards to the telemetry endpoint:

- **Milesight EM400-TLD** — purpose-built for bins. ToF, 27° field of view,
  IP67, plus a temperature sensor for fire detection and an accelerometer for
  lid/tilt status.
- **Dragino LDDS75** — ultrasonic, 280–7500mm, Li-SOCl₂ battery rated for years.

They cost more per bin than the DIY build but need no electronics work. Either
way the confirmation and hysteresis logic still lives here — the hardware only
reports distance.

## Reference material

This project was written from scratch. Several existing GitHub projects were
read for reference during design:

- [cepdnaclk/e19-3yp-Smart-Waste-Management-System](https://github.com/cepdnaclk/e19-3yp-Smart-Waste-Management-System)
- [amr-hammoud/bin-tracker](https://github.com/amr-hammoud/bin-tracker)
- [jmbmartins/IntelligentWasteManagementSystem_IoT](https://github.com/jmbmartins/IntelligentWasteManagementSystem_IoT)

**None of them carries a license**, which means all rights are reserved and
their code cannot be copied into another project. No code from them is used
here. If you clone them to read, keep them out of this repository — `reference/`
is gitignored for exactly that.

## Next steps

- Fill-history sparkline per bin (`GET /api/v1/bins/:id` already returns readings)
- Collection scheduling and route ordering across multiple bins
- Per-user admin accounts instead of a single shared token
- Retention policy for the `readings` table on long-running deployments
