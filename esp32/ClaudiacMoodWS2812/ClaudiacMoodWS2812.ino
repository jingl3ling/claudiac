/**
 * Claudiac — ESP32 + WS2812B strip (8 LEDs) from GET /api/led (emotion.color).
 *
 * If colors never change: set WIFI_SSID / WIFI_PASSWORD below (not CHANGE_ME),
 * open Serial 115200, and read the log (WiFi + HTTP + parsed RGB).
 */

#include <stdio.h>
#include <string.h>
#include <math.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <FastLED.h>

#define CLAUDIAC_DEBUG 1
#define STRIP_SELF_TEST 0

// --- WiFi: MUST set your real network (CHANGE_ME = stuck / no data from server) ---
static const char *WIFI_SSID = "MyOptimum 62d365";
static const char *WIFI_PASSWORD = "1771-blue-14";

static const char *CLAUDIAC_HOST = "claudiac-production.up.railway.app";
static const uint16_t CLAUDIAC_HTTPS_PORT = 443;
static const char *ECG_SOURCE = "bridge";
static const char *DEVICE_ID = "ios-001";
static const char *API_KEY = "";

static const int LED_PIN = 13;
static const int NUM_LEDS = 8;
static const uint8_t BRIGHTNESS = 120;
static const unsigned long POLL_MS = 3000;
static const unsigned long WIFI_TIMEOUT_MS = 30000;
static const unsigned long WIFI_RETRY_MS = 10000;

static CRGB leds[NUM_LEDS];
static unsigned long lastFetch = 0;
static unsigned long lastWifiAttempt = 0;
static bool g_attackMode = false;
static CRGB g_solid(20, 20, 30);
static bool g_wifiUp = false;
static bool g_configOk = true;
static bool g_lastFetchOk = false;
static bool g_hasLastSolid = false;
static CRGB g_lastSolid(0, 0, 0);

#if STRIP_SELF_TEST
static uint32_t selfTestLast = 0;
static uint8_t selfTestHue = 0;
#endif

static bool isPlaceholderCredentials() {
  return (WIFI_SSID[0] == '\0' || strcmp(WIFI_SSID, "CHANGE_ME") == 0 ||
          strcmp(WIFI_PASSWORD, "CHANGE_ME") == 0);
}

static void showErrorNoWifiCreds() {
  // Default to yellow when WiFi isn't configured.
  fill_solid(leds, NUM_LEDS, CRGB(255, 215, 0));
  FastLED.setBrightness(120);
  FastLED.show();
}

static void showWifiConnectAttempt() {
  // Default to yellow when WiFi is down/connecting.
  uint8_t p = 80 + (uint8_t)(60 * (1.0f + sinf(millis() * 0.004f)) * 0.5f);
  fill_solid(leds, NUM_LEDS, CRGB(p, (uint8_t)(p * 0.84f), 0));
  FastLED.show();
}

static void showHttpFailPattern() {
  // Short blink red: got WiFi but /api/led failed (see Serial)
  static uint32_t t = 0;
  if (millis() - t < 200) return;
  t = millis();
  static bool b;
  b = !b;
  fill_solid(leds, NUM_LEDS, b ? CRGB(80, 0, 0) : g_solid);
  FastLED.show();
}

static bool tryConnectWifi() {
  if (isPlaceholderCredentials()) {
    g_configOk = false;
    g_wifiUp = false;
    Serial.println(F("Set WIFI_SSID and WIFI_PASSWORD in this .ino (not CHANGE_ME)."));
    return false;
  }
  g_configOk = true;
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true);
  delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print(F("WiFi: "));
  Serial.print(WIFI_SSID);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > WIFI_TIMEOUT_MS) {
      Serial.println(F(" — TIMEOUT (check SSID/password)"));
      g_wifiUp = false;
      return false;
    }
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  Serial.print(F("IP: "));
  Serial.println(WiFi.localIP());
  g_wifiUp = true;
  return true;
}

static bool parseColorHex(const char *s, CRGB &out) {
  if (!s) return false;
  while (*s == ' ' || *s == '\t') s++;
  if (*s == '#') s++;
  if (strlen(s) != 6) return false;
  for (int i = 0; i < 6; i++) {
    if (!isxdigit((unsigned char)s[i])) return false;
  }
  char *end = nullptr;
  unsigned long v = strtoul(s, &end, 16);
  if (end != s + 6 || v > 0xFFFFFF) return false;
  out = CRGB((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
  return true;
}

static bool setSolidIfChanged(const CRGB &next) {
  if (!g_hasLastSolid) {
    g_hasLastSolid = true;
    g_lastSolid = next;
    g_solid = next;
    return true;
  }
  if (g_lastSolid == next) return false;
  g_lastSolid = next;
  g_solid = next;
  return true;
}

static void buildPath(char *buf, size_t cap) {
  if (strcmp(ECG_SOURCE, "bridge") == 0) {
    snprintf(buf, cap, "/api/led?source=bridge");
  } else if (strcmp(ECG_SOURCE, "upload") == 0) {
    snprintf(buf, cap, "/api/led?source=upload&deviceId=%s", DEVICE_ID);
  } else {
    snprintf(buf, cap, "/api/led?source=%s", ECG_SOURCE);
  }
}

/**
 * Use host + port + path (TLS) — more reliable on ESP32 than begin(client, fullUrlString).
 */
static bool fetchEmotion() {
  if (!g_wifiUp) return false;

  char path[128];
  buildPath(path, sizeof(path));

#if CLAUDIAC_DEBUG
  Serial.print(F("GET https://"));
  Serial.print(CLAUDIAC_HOST);
  Serial.println(path);
#endif

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(15000);

  HTTPClient http;
  // bool begin(WiFiClient &client, const char *host, uint16_t port, const char *path, bool https)
  if (!http.begin(client, CLAUDIAC_HOST, CLAUDIAC_HTTPS_PORT, path, true)) {
    Serial.println(F("http.begin failed"));
    g_lastFetchOk = false;
    return false;
  }
  if (API_KEY[0] != '\0') {
    http.addHeader("x-api-key", API_KEY);
  }
  int code = http.GET();
  String body = http.getString();
  http.end();
#if CLAUDIAC_DEBUG
  Serial.print(F("HTTP "));
  Serial.print(code);
  Serial.print(F(" body len="));
  Serial.println(body.length());
#endif

  if (code != 200) {
    if (code > 0) {
      Serial.println(body.substring(0, min(200, (int)body.length())));
    }
    g_lastFetchOk = false;
    return false;
  }

  StaticJsonDocument<2048> doc;
  if (deserializeJson(doc, body)) {
    Serial.println(F("JSON parse error"));
    g_lastFetchOk = false;
    return false;
  }

  JsonObject emo = doc["emotion"].as<JsonObject>();
  if (!emo) {
    Serial.println(F("No 'emotion' object in JSON"));
    g_lastFetchOk = false;
    return false;
  }

  g_attackMode = (bool)emo["attack_mode"];
  if (!emo.containsKey("color")) {
    Serial.println(F("No 'color' in emotion"));
    g_lastFetchOk = false;
    return false;
  }

  const char *col = emo["color"].as<const char *>();
  if (!col) {
    Serial.println(F("emotion.color is null"));
    g_lastFetchOk = false;
    return false;
  }

  char colorBuf[24];
  snprintf(colorBuf, sizeof(colorBuf), "%s", col);

#if CLAUDIAC_DEBUG
  if (const char *eid = emo["id"].as<const char *>()) {
    Serial.print(F("id="));
    Serial.print(eid);
    Serial.print(F(" color="));
  }
  Serial.println(colorBuf);
#endif

  CRGB nextColor;
  if (!parseColorHex(colorBuf, nextColor)) {
    Serial.println(F("parseColorHex failed"));
    (void)setSolidIfChanged(CRGB(50, 50, 55));
  } else {
    bool changed = setSolidIfChanged(nextColor);
#if CLAUDIAC_DEBUG
    Serial.print(F("RGB "));
    Serial.print(nextColor.r);
    Serial.print(" ");
    Serial.print(nextColor.g);
    Serial.print(" ");
    Serial.println(nextColor.b);
    if (changed) {
      Serial.println(F("LED color changed"));
    } else {
      Serial.println(F("LED color unchanged"));
    }
#endif
  }
  g_lastFetchOk = true;
  return true;
}

static void showAttackFlash() {
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

static void showSolidMood() {
  fill_solid(leds, NUM_LEDS, g_solid);
  FastLED.setBrightness(BRIGHTNESS);
  FastLED.show();
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println(F("\n\n=== ClaudiacMoodWS2812 ==="));

  FastLED.addLeds<WS2812, LED_PIN, GRB>(leds, NUM_LEDS);
  FastLED.setBrightness(BRIGHTNESS);
  fill_solid(leds, NUM_LEDS, CRGB(10, 10, 15));
  FastLED.show();

#if STRIP_SELF_TEST
  Serial.println(F("STRIP_SELF_TEST on"));
  return;
#endif

  if (isPlaceholderCredentials()) {
    Serial.println(F("Edit WIFI_SSID and WIFI_PASSWORD, then re-upload."));
  } else {
    (void)tryConnectWifi();
  }
  lastFetch = 0;
  lastWifiAttempt = millis();
}

void loop() {
#if STRIP_SELF_TEST
  for (uint8_t i = 0; i < NUM_LEDS; i++) {
    leds[i] = CHSV(selfTestHue + i * 20, 255, 200);
  }
  FastLED.show();
  selfTestHue++;
  delay(20);
  return;
#endif

  if (isPlaceholderCredentials() || !g_configOk) {
    showErrorNoWifiCreds();
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    g_wifiUp = false;
    if (millis() - lastWifiAttempt > WIFI_RETRY_MS) {
      lastWifiAttempt = millis();
      Serial.println(F("Retry WiFi..."));
      (void)tryConnectWifi();
    } else {
      showWifiConnectAttempt();
    }
    return;
  }
  g_wifiUp = true;

  unsigned long now = millis();
  if (now - lastFetch < POLL_MS) {
    if (g_attackMode) {
      showAttackFlash();
    } else if (!g_lastFetchOk) {
      showHttpFailPattern();
    } else {
      showSolidMood();
    }
    return;
  }
  lastFetch = now;

  bool ok = fetchEmotion();
  if (ok) {
    Serial.println(F("poll ok"));
  } else {
    Serial.println(F("fetch failed (HTTP/JSON) — blinking red on strip"));
  }

  if (g_attackMode) {
    showAttackFlash();
  } else if (!g_lastFetchOk) {
    showHttpFailPattern();
  } else {
    showSolidMood();
  }
}
