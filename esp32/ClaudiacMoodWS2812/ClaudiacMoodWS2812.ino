/**
 * Claudiac — ESP32 + WS2812B strip (8 LEDs) driven by server mood/emotion color.
 *
 * Server: use GET /api/led (small JSON) — same `source` / `deviceId` as /api/analyze.
 *
 * Arduino IDE 2.x + esp32 by Espressif
 * Library Manager: install "FastLED" by Daniel Garcia, "ArduinoJson" by Benoit Blanchon
 *
 * Wiring: DI of first LED to GPIO 13, 5V + GND (use level shifter 3.3V→5V for long strips;
 *         8 pixels often work at 3.3V on short wire — YMMV.)
 */

#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <FastLED.h>

// ---------------- config ----------------
static const char *WIFI_SSID = "jh828";
static const char *WIFI_PASSWORD = "Lisongying9";

// Set to your Claudiac base (no trailing slash). Examples:
//   "https://claudiac-production.up.railway.app"
//   "http://192.168.1.42:5100"
static const char *CLAUDIAC_BASE = "https://claudiac-production.up.railway.app";

// Match web UI / iOS: demo | upload | daq
static const char *ECG_SOURCE = "demo";
// If source=upload, must match ECGIngest deviceId
static const char *DEVICE_ID = "ios-001";

// Optional: set in Railway (or .env) on server; leave empty if unused
static const char *API_KEY = "";

// WS2812B
static const int LED_PIN = 13;
static const int NUM_LEDS = 8;
static const uint8_t BRIGHTNESS = 120;  // 0-255

static const unsigned long POLL_MS = 2000;  // avoid hammering the API

// ---------------- state ----------------
CRGB leds[NUM_LEDS];
unsigned long lastFetch = 0;

bool g_attackMode = false;
CRGB g_solid(40, 40, 40);  // default idle / unknown

bool isHttps(const char *url) {
  return strncmp(url, "https://", 8) == 0;
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

// Parse #RRGGBB (Claudiac returns 6-digit hex) into FastLED
bool parseColorHex(const char *s, CRGB &out) {
  if (!s || s[0] != '#' || strlen(s) != 7) return false;
  char *end = nullptr;
  unsigned long v = strtoul(s + 1, &end, 16);
  if (end != s + 7) return false;
  out = CRGB((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
  return true;
}

void buildPath(char *buf, size_t cap) {
  // /api/led?source=demo&deviceId=ios-001
  if (strcmp(ECG_SOURCE, "upload") == 0) {
    snprintf(buf, cap, "/api/led?source=upload&deviceId=%s", DEVICE_ID);
  } else {
    snprintf(buf, cap, "/api/led?source=%s", ECG_SOURCE);
  }
}

bool fetchEmotion() {
  char path[120];
  buildPath(path, sizeof(path));
  const String url = String(CLAUDIAC_BASE) + String(path);

  HTTPClient http;
  if (isHttps(CLAUDIAC_BASE)) {
    WiFiClientSecure s;
    s.setInsecure();
    s.setTimeout(12000);
    if (!http.begin(s, url)) {
      Serial.println("http.begin (https) failed");
      return false;
    }
  } else {
    WiFiClient c;
    c.setTimeout(12000);
    if (!http.begin(c, url)) {
      Serial.println("http.begin (http) failed");
      return false;
    }
  }
  if (API_KEY[0] != '\0') {
    http.addHeader("x-api-key", API_KEY);
  }
  int code = http.GET();
  if (code != 200) {
    Serial.print("GET ");
    Serial.print(path);
    Serial.print(" -> ");
    Serial.println(code);
    http.end();
    return false;
  }
  String body = http.getString();
  http.end();

  StaticJsonDocument<1024> doc;
  if (deserializeJson(doc, body)) {
    Serial.println("JSON parse error");
    return false;
  }

  JsonObject emo = doc["emotion"].as<JsonObject>();
  if (!emo) {
    Serial.println("no emotion in response");
    g_attackMode = false;
    return true;
  }

  g_attackMode = emo["attack_mode"] | false;
  const char *col = emo["color"] | "#505050";
  if (!parseColorHex(col, g_solid)) {
    g_solid = CRGB(50, 50, 55);
  }

  if (const char *id = emo["id"] | nullptr) {
    Serial.print("emotion: ");
    Serial.println(id);
  }
  return true;
}

void showAttackFlash() {
  static bool phase = false;
  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last < 200) return;
  last = now;
  phase = !phase;
  CRGB c = phase ? CRGB(255, 0, 0) : CRGB(0, 0, 0);
  fill_solid(leds, NUM_LEDS, c);
  FastLED.show();
}

void showSolidMood() {
  fill_solid(leds, NUM_LEDS, g_solid);
  FastLED.setBrightness(BRIGHTNESS);
  FastLED.show();
}

void setup() {
  Serial.begin(115200);
  delay(200);

  FastLED.addLeds<WS2812, LED_PIN, GRB>(leds, NUM_LEDS);
  FastLED.setBrightness(BRIGHTNESS);
  fill_solid(leds, NUM_LEDS, CRGB(10, 10, 15));
  FastLED.show();

  connectWifi();
  lastFetch = 0;
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
  }

  unsigned long now = millis();
  if (now - lastFetch >= POLL_MS) {
    lastFetch = now;
    if (fetchEmotion()) {
      Serial.println("poll ok");
    }
  }

  if (g_attackMode) {
    showAttackFlash();
  } else {
    FastLED.setBrightness(BRIGHTNESS);
    showSolidMood();
  }
}
