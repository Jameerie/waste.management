/**
 * ESP32 bin fill sensor.
 *
 * Wakes on a timer, measures the distance to the rubbish surface, posts one
 * reading, and goes straight back to deep sleep. Everything here is shaped by
 * two constraints:
 *
 *   BATTERY. The radio is by far the most expensive thing on the board, so it
 *   is switched on as late as possible and off as early as possible. Between
 *   readings the ESP32 draws microamps, not milliamps. An always-connected
 *   design flattens an 18650 in about a day; this one runs for months.
 *
 *   BAD READINGS. Ultrasonic sensors return nonsense regularly - a bag flops
 *   across the beam, or the pulse catches a bin wall. We take a burst of
 *   samples and send the MEDIAN, which discards outliers instead of averaging
 *   them in. The server applies further confirmation logic on top.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "config.h"

// --- Tunables -------------------------------------------------------------
static const int   SAMPLE_COUNT      = 7;      // odd, so the median is a real sample
static const int   SAMPLE_DELAY_MS   = 60;     // let echoes die between pings
static const unsigned long ECHO_TIMEOUT_US = 30000UL;  // ~5m; also caps a dead sensor
static const unsigned long WIFI_TIMEOUT_MS = 20000UL;  // never spin on the radio
static const int   HTTP_TIMEOUT_MS   = 10000;

// Survives deep sleep - lets us notice a run of failures across wakeups.
RTC_DATA_ATTR int bootCount = 0;
RTC_DATA_ATTR int consecutiveFailures = 0;

static void sleepNow() {
  Serial.println("sleeping");
  Serial.flush();
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  esp_sleep_enable_timer_wakeup((uint64_t)SLEEP_MINUTES * 60ULL * 1000000ULL);
  esp_deep_sleep_start();
}

/** One ultrasonic ping. Returns distance in mm, or -1 on timeout. */
static long readDistanceOnce() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(4);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  // pulseIn returns 0 on timeout - treat as a failed sample, not as zero
  // distance, which would otherwise read as a completely full bin.
  unsigned long duration = pulseIn(ECHO_PIN, HIGH, ECHO_TIMEOUT_US);
  if (duration == 0) return -1;

  // Speed of sound ~343 m/s => 0.343 mm/us, halved for the round trip.
  return (long)(duration * 0.1715f);
}

static int compareLong(const void *a, const void *b) {
  long diff = (*(const long *)a) - (*(const long *)b);
  return (diff > 0) - (diff < 0);
}

/** Median of a burst of samples. Returns -1 if too few succeeded. */
static long readDistanceMedian() {
  long samples[SAMPLE_COUNT];
  int valid = 0;

  for (int i = 0; i < SAMPLE_COUNT; i++) {
    long mm = readDistanceOnce();
    if (mm > 0) samples[valid++] = mm;
    delay(SAMPLE_DELAY_MS);
  }

  // A couple of dropped pings is normal; mostly-dropped means the sensor is
  // unplugged, flooded, or dead, and we should not invent a reading.
  if (valid < (SAMPLE_COUNT / 2) + 1) {
    Serial.printf("only %d/%d valid samples\n", valid, SAMPLE_COUNT);
    return -1;
  }

  qsort(samples, valid, sizeof(long), compareLong);
  return samples[valid / 2];
}

/** Battery volts through the divider, or -1 when not fitted. */
static float readBatteryVolts() {
#if BATTERY_PIN < 0
  return -1.0f;
#else
  long total = 0;
  for (int i = 0; i < 8; i++) {
    total += analogRead(BATTERY_PIN);
    delay(5);
  }
  float adc = total / 8.0f;
  // 12-bit ADC over the default 3.3V reference, scaled back up through the
  // divider. BATTERY_CALIBRATION absorbs the ESP32's ADC nonlinearity - set
  // it by comparing against a multimeter.
  return (adc / 4095.0f) * 3.3f * BATTERY_CALIBRATION;
#endif
}

static bool connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - started > WIFI_TIMEOUT_MS) {
      Serial.println("wifi timeout");
      return false;
    }
    delay(250);
  }
  Serial.printf("wifi ok, rssi %d\n", WiFi.RSSI());
  return true;
}

static bool postReading(long distanceMm, float batteryV) {
  WiFiClientSecure client;

  // NOTE: setInsecure() skips certificate validation. It is fine on a trusted
  // LAN, but for a bin on the public internet load your server's root CA with
  // client.setCACert(rootCa) instead - otherwise the device token can be
  // captured by anything that can intercept the connection.
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);

  String url = String(SERVER_URL) + "/api/v1/bins/" + BIN_ID + "/telemetry";
  if (!http.begin(client, url)) {
    Serial.println("http begin failed");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);

  String body = String("{\"distance_mm\":") + distanceMm +
                ",\"rssi\":" + WiFi.RSSI();
  if (batteryV > 0) body += String(",\"battery_v\":") + String(batteryV, 2);
  body += "}";

  int status = http.POST(body);
  Serial.printf("POST %s -> %d\n", url.c_str(), status);
  if (status > 0) Serial.println(http.getString());
  http.end();

  return status >= 200 && status < 300;
}

void setup() {
  Serial.begin(115200);
  delay(50);
  bootCount++;
  Serial.printf("\n--- boot %d ---\n", bootCount);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  // Measure BEFORE the radio comes up: WiFi causes a current surge that pulls
  // the rail down and skews both the ADC and the sensor.
  long distanceMm = readDistanceMedian();
  float batteryV = readBatteryVolts();
  Serial.printf("distance %ld mm, battery %.2f V\n", distanceMm, batteryV);

  if (distanceMm < 0) {
    // Nothing worth sending. Sleeping keeps a broken sensor from flattening
    // the cell; the server's offline sweep will notice the silence.
    consecutiveFailures++;
    Serial.printf("no valid reading (%d in a row)\n", consecutiveFailures);
    sleepNow();
  }

  if (connectWiFi() && postReading(distanceMm, batteryV)) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
    Serial.printf("upload failed (%d in a row)\n", consecutiveFailures);
  }

  sleepNow();
}

// Never runs: setup() always ends in deep sleep, and waking restarts setup().
void loop() {}
