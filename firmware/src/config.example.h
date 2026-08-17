// Copy to config.h and fill in. config.h is gitignored - never commit secrets.
#pragma once

// --- Network --------------------------------------------------------------
#define WIFI_SSID      "your-wifi"
#define WIFI_PASSWORD  "your-password"

// --- Server ---------------------------------------------------------------
// Base URL of the waste-management server, no trailing slash.
#define SERVER_URL     "https://waste.example.com"

// From the dashboard when you registered the bin. Shown only once.
#define BIN_ID         "bin-xxxxxxxx"
#define DEVICE_TOKEN   "paste-the-device-token-here"

// --- Timing ---------------------------------------------------------------
// How long to sleep between readings. Hourly is a good default: it gives a
// full bin an alert within ~3 hours (3 confirmations) while lasting months
// on one 18650. Shorter intervals cost battery for very little benefit.
#define SLEEP_MINUTES  60

// --- Hardware pins --------------------------------------------------------
#define TRIG_PIN       5
#define ECHO_PIN       18

// Battery sense through a 2x100k divider to this ADC pin. Set to -1 to skip
// battery reporting (e.g. when mains powered).
#define BATTERY_PIN    34

// Multiply the ADC reading by this to get true battery volts. Measure your
// cell with a multimeter and adjust until the reported figure matches.
#define BATTERY_CALIBRATION  2.0f
