# Use Case Diagram

Who uses the system and what they can do with it.

There are three actors. The **Admin** is the only human who operates the
software. The **Bin Sensor** is a device actor — it initiates telemetry on its
own schedule rather than being driven by a person. **Telegram** is an external
system actor that receives outbound alerts.

Note that the Collector never touches the software: they are notified through
the Admin and confirm collection indirectly, either by the sensor observing the
level drop or by the Admin pressing "Mark collected". Adding a collector-facing
app would be a future change, not a current capability.

```mermaid
flowchart TB
    admin(("👤<br/>Admin"))
    sensor(("📡<br/>Bin Sensor<br/><i>device</i>"))
    telegram(("💬<br/>Telegram<br/><i>external</i>"))

    subgraph system [Waste Management System]
        direction LR

        uc1("Register a bin")
        uc13("Issue device token")
        uc2("Calibrate empty/full distances")
        uc3("Tune alert thresholds")
        uc4("Remove a bin")
        uc5("View live bin status")
        uc6("View event history")
        uc8("Mark bin collected")
        uc7("Report telemetry")
        uc14("Evaluate fill state")
        uc9("Raise full alert")
        uc10("Raise offline alert")
        uc11("Raise low-battery alert")
        uc12("Raise fire warning")
    end

    admin --- uc1
    admin --- uc2
    admin --- uc3
    admin --- uc4
    admin --- uc5
    admin --- uc6
    admin --- uc8

    sensor --- uc7

    uc1 -.->|"«include»"| uc13
    uc7 -.->|"«include»"| uc14
    uc14 -.->|"«extend»"| uc9
    uc14 -.->|"«extend»"| uc11
    uc14 -.->|"«extend»"| uc12

    uc9 --- telegram
    uc10 --- telegram
    uc11 --- telegram
    uc12 --- telegram

    classDef actor fill:#2a78d6,stroke:#184f95,color:#fff
    classDef uc fill:#fcfcfb,stroke:#898781,color:#0b0b0b
    class admin,sensor,telegram actor
    class uc1,uc2,uc3,uc4,uc5,uc6,uc7,uc8,uc9,uc10,uc11,uc12,uc13,uc14 uc
```

The use cases group into three areas:

| Area | Use cases |
|---|---|
| **Fleet management** | Register a bin · Issue device token · Calibrate · Tune thresholds · Remove |
| **Monitoring** | View live status · View event history · Report telemetry · Evaluate fill state |
| **Response** | Mark collected · Raise full / offline / low-battery / fire alerts |

## Notes on the relationships

**Issue device token** is `«include»`d in *Register a bin* because it always
happens as part of registration — the token is generated and displayed exactly
once, and cannot be retrieved afterwards.

**Evaluate fill state** is `«include»`d in *Report telemetry* because every
reading runs through the state machine. The alerts hanging off it are
`«extend»` rather than `«include»`: they only occur when their conditions are
met, which for a full-bin alert means three consecutive confirmations, not a
single high reading.

*Receive offline alert* is deliberately not connected to the sensor. It fires
precisely because the sensor said nothing — it is raised by a timer sweep on
the server, which is what makes a silently dead sensor detectable.
