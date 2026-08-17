# Data Model (ER Diagram)

Three tables. The schema lives in [`src/db.js`](../../src/db.js).

The `bins` table is wider than you might expect because it carries three
distinct kinds of column: **configuration** (calibration and thresholds, set by
the admin), **live state** (the state machine's working memory), and
**identity**. Keeping the state machine's counters on the row is what lets the
decision logic stay pure — `applyReading()` receives the whole row, decides,
and returns a patch, without querying anything itself.

```mermaid
erDiagram
    BINS ||--o{ READINGS : "records"
    BINS ||--o{ EVENTS : "raises"

    BINS {
        TEXT id PK "bin-xxxxxxxx"
        TEXT name "display name"
        TEXT location "where it stands"
        TEXT token_hash "sha256 of device token"

        REAL empty_distance_mm "calibration: bin empty"
        REAL full_distance_mm "calibration: bin full"

        REAL full_threshold_pct "default 85"
        REAL clear_threshold_pct "default 40 - hysteresis floor"
        INTEGER consecutive_required "default 3"
        REAL repeat_alert_hours "reminder; 0 disables"
        REAL offline_after_hours "silence before alarm"
        REAL low_battery_v "default 3.4"
        REAL high_temp_c "default 60 - fire"

        TEXT state "OK or FULL"
        INTEGER state_changed_at "epoch ms"
        INTEGER last_alert_at "for repeat suppression"
        INTEGER last_seen_at "drives offline sweep"
        REAL last_level_pct "cached for dashboard"
        INTEGER consecutive_high "confirmation counter"
        INTEGER consecutive_low "clear counter"
        INTEGER online "1 or 0"
        INTEGER battery_alerted "single-shot latch"
        INTEGER temp_alerted "single-shot latch"
        INTEGER created_at "epoch ms"
    }

    READINGS {
        INTEGER id PK
        TEXT bin_id FK
        REAL distance_mm "as reported, post-median"
        REAL level_pct "derived at ingest"
        REAL battery_v "nullable"
        REAL temperature_c "nullable"
        INTEGER rssi "nullable, wifi signal"
        INTEGER received_at "epoch ms"
    }

    EVENTS {
        INTEGER id PK
        TEXT bin_id FK
        TEXT type "FULL, EMPTIED, OFFLINE, ..."
        TEXT message "human-readable alert text"
        REAL level_pct "level when raised"
        INTEGER notified "1 if delivered"
        INTEGER created_at "epoch ms"
    }
```

## Event types

The full set emitted by [`src/fill.js`](../../src/fill.js):

| Type | Raised when |
|---|---|
| `FULL` | Level confirmed above threshold for N consecutive readings |
| `STILL_FULL` | Reminder — full and uncollected past `repeat_alert_hours` |
| `EMPTIED` | Confirmed below the clear threshold, or marked by an admin |
| `OFFLINE` | No telemetry for `offline_after_hours` |
| `ONLINE` | A previously silent bin reports again |
| `LOW_BATTERY` | Battery at or below `low_battery_v` |
| `BATTERY_OK` | Recovered by a real margin, re-arming the alert |
| `HIGH_TEMP` | At or above `high_temp_c` — possible fire |

## Design notes

**`level_pct` is stored on each reading, not computed on read.** Calibration
can change, and a historical reading should keep the interpretation it had when
it was taken. Recalibrating changes future readings, not the past.

**Both `battery_alerted` and `temp_alerted` are latches, not booleans about the
current value.** They record *"we have already told someone"*, which is what
stops a bin on a dying cell from sending an alert every hour. Each re-arms only
after a genuine recovery margin — 0.15V for battery, 5°C for temperature — so a
value hovering exactly at the threshold cannot flap.

**Cascading deletes.** `ON DELETE CASCADE` with `PRAGMA foreign_keys = ON`
means removing a bin takes its readings and events with it.

**Retention.** `readings` grows without bound — one row per bin per wake cycle.
At hourly readings that is ~8,800 rows per bin per year, which SQLite handles
comfortably, but a long-running fleet deployment should add a pruning job.
