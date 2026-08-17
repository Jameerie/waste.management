# Architecture Diagram

How the parts fit together, and which file does what.

The shape to notice: **`fill.js` sits at the centre but touches nothing.** It
has no database access, no network calls, and no clock — time is passed in as
an argument. Everything it needs arrives as parameters and everything it
decides comes back as a return value. That is what makes the decision logic
exhaustively testable without mocks, and it is the main structural difference
between this and a typical bin-monitor project where threshold checks are
scattered through request handlers.

```mermaid
flowchart TB
    subgraph field [Field hardware]
        direction LR
        sensor["JSN-SR04T<br/>ultrasonic sensor"]
        esp["ESP32<br/><i>firmware/src/main.cpp</i><br/>median of 7 · deep sleep"]
        batt["18650 + TP4056<br/>battery + charger"]
        sensor -->|"echo pulse"| esp
        batt -.->|"ADC divider"| esp
    end

    subgraph edge [Alternative hardware]
        lora["Milesight EM400-TLD<br/>or Dragino LDDS75"]
        gw["LoRaWAN gateway<br/>+ webhook"]
        lora --> gw
    end

    subgraph server [Node server · zero npm dependencies]
        direction TB
        http["<b>http.js</b><br/>router · JSON · bearer parsing"]
        routes["<b>routes.js</b><br/>endpoints · admin + device auth"]
        alerts["<b>alerts.js</b><br/>orchestration<br/>persist → dispatch"]
        fill["<b>fill.js</b><br/><i>pure decision logic</i><br/>median · confirmation · hysteresis"]
        db["<b>db.js</b><br/>schema · queries · token hashing"]
        notifier["<b>notifier.js</b><br/>alert transport"]
        sweep["<b>server.js</b><br/>offline sweep timer"]

        http --> routes
        routes --> alerts
        alerts --> fill
        alerts --> db
        alerts --> notifier
        sweep --> alerts
    end

    store[("SQLite<br/><i>node:sqlite</i><br/>bins · readings · events")]
    tg["Telegram Bot API<br/><i>free, unmetered</i>"]
    phone(["📱 Admin phone"])
    dash["Dashboard<br/><i>public/index.html</i><br/>no build step"]
    sim["Simulator<br/><i>tools/simulate.js</i>"]

    esp -->|"HTTPS POST<br/>/api/v1/bins/:id/telemetry"| http
    gw -->|"HTTPS POST<br/>same endpoint"| http
    sim -.->|"fake telemetry<br/>no hardware needed"| http
    dash -->|"HTTPS + admin token"| http

    db <--> store
    notifier -->|"sendMessage"| tg
    tg --> phone

    classDef pure fill:#0ca30c,stroke:#006300,color:#fff
    classDef core fill:#2a78d6,stroke:#184f95,color:#fff
    classDef ext fill:#fcfcfb,stroke:#898781,color:#0b0b0b
    classDef data fill:#eda100,stroke:#c98500,color:#0b0b0b

    class fill pure
    class http,routes,alerts,db,notifier,sweep core
    class sensor,esp,batt,lora,gw,tg,phone,dash,sim ext
    class store data
```

## Layer responsibilities

| Layer | Files | Responsibility |
|---|---|---|
| **Device** | `firmware/` | Measure, filter outliers, sleep. Sends a median, never a raw ping. |
| **Transport** | — | HTTPS with a per-bin bearer token. LoRaWAN webhooks post to the identical endpoint. |
| **API** | `http.js`, `routes.js` | Routing, authentication, request validation. |
| **Orchestration** | `alerts.js` | Calls the pure logic, then persists and dispatches what it returns. |
| **Decision** | `fill.js` | *Pure.* All fill-state, battery, temperature and offline decisions. |
| **Storage** | `db.js` | SQLite schema and queries. Tokens stored as SHA-256 hashes only. |
| **Notification** | `notifier.js` | Telegram delivery. Failures are logged, never propagated. |
| **Client** | `public/index.html` | Dashboard. Plain HTML/JS, no build toolchain. |

## Two deliberate choices

**Alert delivery cannot break ingestion.** `notifier.js` swallows its own
failures and returns a boolean. If Telegram is down, the reading is still
stored and the event row is still written — just with `notified = 0`. Losing a
notification is recoverable; losing the data is not.

**The offline sweep is a timer, not a request handler.** It has to be, because
it detects the *absence* of traffic. No incoming request can trigger it, so it
runs on an interval from `server.js` and calls the same `alerts.js` dispatch
path as everything else.
