const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** Must match `AppConfig.deviceId` in the iOS ingest app for upload mode. */
const API_BASE_URL = "https://claudiac-production.up.railway.app";
const UPLOAD_DEVICE_ID = "ios-001";

const connectBtn = /** @type {HTMLButtonElement} */ ($("connectBtn"));
const ecgSourceEl = /** @type {HTMLSelectElement} */ ($("ecgSource"));

const bpmValueEl = $("bpmValue");
const statusTextEl = $("statusText");
const emotionTextEl = $("emotionText");
const errorBoxEl = $("errorBox");
const heartEl = $("heart");
const glowEl = $("glow");
const demoButtonsEl = $("demoButtons");

const stop0 = /** @type {SVGStopElement} */ (document.getElementById("hgStop0"));
const stop1 = /** @type {SVGStopElement} */ (document.getElementById("hgStop1"));
const stop2 = /** @type {SVGStopElement} */ (document.getElementById("hgStop2"));

let timer = null;
let lastBpm = null;
let demoMode = false;

let attackTimer = null;
let attackPhase = false;

const STALE_AFTER_MS = 4000;
let lastGoodAt = 0;

const DEMO_PERSIST_KEY = "claudiac.demoEmotion";
const DEMO_PERSIST_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function persistDemoEmotionId(id) {
  try {
    localStorage.setItem(DEMO_PERSIST_KEY, JSON.stringify({ id, at: Date.now() }));
  } catch {
    // ignore
  }
}

function readPersistedDemoEmotionId() {
  try {
    const raw = localStorage.getItem(DEMO_PERSIST_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.id !== "string") return null;
    const at = typeof obj.at === "number" ? obj.at : 0;
    if (at && Date.now() - at > DEMO_PERSIST_TTL_MS) return null;
    // Don’t auto-restore Heart Attack on refresh (default should be yellow).
    if (obj.id === "heart_attack") return null;
    return obj.id;
  } catch {
    return null;
  }
}

function clearPersistedDemoEmotion() {
  try {
    localStorage.removeItem(DEMO_PERSIST_KEY);
  } catch {
    // ignore
  }
}

function setError(message) {
  if (!message) {
    errorBoxEl.hidden = true;
    errorBoxEl.textContent = "";
    return;
  }
  errorBoxEl.hidden = false;
  errorBoxEl.textContent = message;
}

function setStatus(text, kind = "muted") {
  statusTextEl.textContent = text;
  statusTextEl.style.color =
    kind === "ok" ? "var(--ok)" : kind === "warn" ? "var(--warn)" : "var(--muted)";
}

function setIdle(isIdle) {
  const v = isIdle ? "idle" : "live";
  heartEl.dataset.state = v;
  glowEl.dataset.state = v;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function bpmToBeatSeconds(bpm) {
  const seconds = 60 / bpm;
  return clamp(seconds, 0.33, 1.6);
}

function applyBpm(bpm) {
  bpmValueEl.textContent = String(Math.round(bpm));
  document.documentElement.style.setProperty("--beat", `${bpmToBeatSeconds(bpm)}s`);
  setIdle(false);
}

function stopAttackMode() {
  document.documentElement.dataset.demo = "";
  if (attackTimer) window.clearInterval(attackTimer);
  attackTimer = null;
  attackPhase = false;
}

/**
 * Map BPM to a heart accent: cooler / calmer at low rates, warmer at higher rates.
 * Uses HSL so the gradient always reads clearly on the SVG.
 */
function applyHeartThemeFromBpm(bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0) return;
  const x = clamp(bpm, 45, 175);
  // ~240° (blue) at low HR → ~8° (red) at high HR
  const hue = Math.round(240 - (x - 45) * (232 / 130));
  const col = `hsl(${hue} 72% 48%)`;
  const colSoft = `hsl(${hue} 72% 48% / 0.32)`;
  document.documentElement.style.setProperty("--accent", col);
  document.documentElement.style.setProperty("--accentSoft", colSoft);
  stop0.setAttribute("stop-color", "#ffffff");
  stop1.setAttribute("stop-color", col);
  stop2.setAttribute("stop-color", col);
}

/**
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number } | null}
 */
function parseHexRgb(hex) {
  const s = String(hex).trim();
  // Allow "#RRGGBB" or "RRGGBB" from API
  const m6 = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m6) {
    const v = m6[1];
    return {
      r: parseInt(v.slice(0, 2), 16),
      g: parseInt(v.slice(2, 4), 16),
      b: parseInt(v.slice(4, 6), 16),
    };
  }
  return null;
}

function setThemeAccent(hex) {
  const h = String(hex).trim();
  if (!h) return;
  document.documentElement.style.setProperty("--accent", h);
  // 8-char #RRGGBBAA is unevenly supported in gradients; use rgba for --accentSoft.
  const rgb = parseHexRgb(h);
  if (rgb) {
    document.documentElement.style.setProperty(
      "--accentSoft",
      `rgba(${rgb.r},${rgb.g},${rgb.b},0.32)`
    );
  } else {
    document.documentElement.style.setProperty("--accentSoft", "rgba(255,45,85,0.32)");
  }

  // Update SVG gradient stops to use the accent color (with a little “chrome” variety).
  stop0.setAttribute("stop-color", "#ffffff");
  stop1.setAttribute("stop-color", h);
  stop2.setAttribute("stop-color", h);
}

async function bridgeSetEmotionId(id) {
  const baseUrl = API_BASE_URL.replace(/\/+$/, "");
  try {
    await fetch(`${baseUrl}/api/bridge/emotion`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch {
    // Bridge is best-effort (don’t block UI if backend is offline).
  }
}

async function bridgeClearEmotion() {
  const baseUrl = API_BASE_URL.replace(/\/+$/, "");
  try {
    await fetch(`${baseUrl}/api/bridge/emotion`, { method: "DELETE" });
  } catch {
    // ignore
  }
}

/** Live mode: use rules-based emotion from `/api/analyze` (HR + HRV + waveform). */
function applyEmotionFromServer(emo) {
  if (!emo || typeof emo !== "object") return;
  if (emo.attack_mode) {
    document.documentElement.dataset.demo = "heart-attack";
    if (!attackTimer) {
      attackTimer = window.setInterval(() => {
        attackPhase = !attackPhase;
        const c = attackPhase ? "#000000" : "#ff0000";
        stop0.setAttribute("stop-color", c);
        stop1.setAttribute("stop-color", c);
        stop2.setAttribute("stop-color", c);
        document.documentElement.style.setProperty("--accent", "#ff0000");
        document.documentElement.style.setProperty("--accentSoft", "rgba(255,0,0,0.42)");
      }, 180);
    }
    return;
  }
  if (attackTimer) {
    window.clearInterval(attackTimer);
    attackTimer = null;
    attackPhase = false;
  }
  const uiKey =
    typeof emo.ui_key === "string" && emo.ui_key
      ? emo.ui_key
      : typeof emo.id === "string"
        ? emo.id.replace(/_/g, "-")
        : "";
  if (uiKey) document.documentElement.dataset.demo = uiKey;
  if (emo.color) setThemeAccent(emo.color);
}

/**
 * Canonical list: `id` = server `emotion.id` from `algorithms/emotion.py` (ECG / iOS ingest).
 * Labels, colors, and demoBpm follow the same rules table as `EMOTION_STYLES` in Python.
 */
const EMOTION_DEFS = {
  heart_attack: {
    label: "Heart Attack",
    swatch: "#ff0000",
    mode: "attack",
    demoBpm: 170,
  },
  anger: { label: "Anger", swatch: "#FF0000", demoBpm: 96 },
  anxiety: { label: "Anxiety", swatch: "#FF8C00", demoBpm: 100 },
  fear: { label: "Fear", swatch: "#8A2BE2", demoBpm: 92 },
  joy: { label: "Joy", swatch: "#FFD700", demoBpm: 72 },
  envy: { label: "Envy", swatch: "#00CED1", demoBpm: 75 },
  disgust: { label: "Disgust", swatch: "#32CD32", demoBpm: 74 },
  embarrassment: { label: "Embarrassment", swatch: "#FF69B4", demoBpm: 70 },
  ennui: { label: "Ennui", swatch: "#3A3B5C", demoBpm: 55 },
  sadness: { label: "Sadness", swatch: "#4169E1", demoBpm: 58 },
};

const EMOTION_ORDER = [
  "heart_attack",
  "anger",
  "anxiety",
  "fear",
  "joy",
  "envy",
  "disgust",
  "embarrassment",
  "ennui",
  "sadness",
];

const EMOTIONS = EMOTION_ORDER.map((id) => {
  const d = EMOTION_DEFS[id];
  if (!d) throw new Error(`Missing EMOTION_DEFS[${id}]`);
  return {
    id,
    key: id === "heart_attack" ? "heart-attack" : id,
    label: d.label,
    swatch: d.swatch,
    mode: d.mode,
    demoBpm: d.demoBpm,
  };
});

function renderDemoButtons() {
  demoButtonsEl.innerHTML = "";
  for (const emo of EMOTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pill";
    btn.dataset.key = emo.key;
    btn.innerHTML = `<span class="name">${emo.label}</span><span class="swatch" aria-hidden="true"></span>`;
    const sw = /** @type {HTMLElement} */ (btn.querySelector(".swatch"));
    sw.style.background = emo.mode === "attack" ? "linear-gradient(90deg, #ff0000, #000000)" : emo.swatch;
    btn.addEventListener("click", () => applyEmotionDemo(emo));
    demoButtonsEl.appendChild(btn);
  }
}

function applyEmotionDemo(emo) {
  // A demo selection should “stick” until the user explicitly reconnects.
  // Otherwise the polling loop will immediately overwrite the theme.
  if (timer) window.clearInterval(timer);
  timer = null;

  demoMode = true;
  lastBpm = null;
  lastGoodAt = 0;
  setError("");
  setStatus("demo (emotion)", "warn");
  if (emo?.id) {
    persistDemoEmotionId(emo.id);
    void bridgeSetEmotionId(emo.id);
  }
  emotionTextEl.textContent = emo?.label ? String(emo.label) : "—";

  if (emo.mode === "attack") {
    stopAttackMode();
    document.documentElement.dataset.demo = "heart-attack";
    // Flash by swapping the heart fill between red and black quickly.
    attackTimer = window.setInterval(() => {
      attackPhase = !attackPhase;
      const c = attackPhase ? "#000000" : "#ff0000";
      stop0.setAttribute("stop-color", c);
      stop1.setAttribute("stop-color", c);
      stop2.setAttribute("stop-color", c);
      document.documentElement.style.setProperty("--accent", "#ff0000");
      document.documentElement.style.setProperty("--accentSoft", "rgba(255,0,0,0.42)");
    }, 180);

    applyBpm(typeof emo.demoBpm === "number" && emo.demoBpm > 0 ? emo.demoBpm : 170);
    return;
  }

  stopAttackMode();
  document.documentElement.dataset.demo = emo.key;
  setThemeAccent(emo.swatch);
  const bpm = typeof emo.demoBpm === "number" && emo.demoBpm > 0 ? emo.demoBpm : 72;
  applyBpm(bpm);
}

async function fetchFromClaudiacOnce() {
  // If the user picked a demo, keep it running until they hit Connect.
  if (demoMode) return;

  const baseUrl = API_BASE_URL.replace(/\/+$/, "");
  const source = ecgSourceEl.value;
  const deviceId = UPLOAD_DEVICE_ID;
  const url = new URL(`${baseUrl}/api/analyze`);
  url.searchParams.set("source", source);
  if (source === "upload") url.searchParams.set("deviceId", deviceId);
  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}${bodyText ? ` — ${bodyText}` : ""}`);
    }

    // Expected shape: { heart_rate: { bpm: number|null, ... }, mood: {...}, ... }
    const data = await res.json();
    const rawBpm = data?.heart_rate?.bpm;
    // Important: `Number(null) === 0` in JavaScript, but JSON `null` means "unknown" here.
    const bpm = rawBpm === null || rawBpm === undefined ? Number.NaN : Number(rawBpm);

    stopAttackMode();
    demoMode = false;

    setError("");

    const emo = data?.emotion;
    if (emo?.label) {
      emotionTextEl.textContent = emo.label;
    } else {
      emotionTextEl.textContent = "—";
    }

    if (Number.isFinite(bpm) && bpm > 0) {
      if (emo?.color) {
        applyEmotionFromServer(emo);
      } else {
        applyHeartThemeFromBpm(bpm);
      }
      setStatus("connected", "ok");
      applyBpm(bpm);
      lastBpm = bpm;
      lastGoodAt = Date.now();
      return;
    }

    if (emo?.color) {
      applyEmotionFromServer(emo);
    } else {
      document.documentElement.dataset.demo = "";
    }
    bpmValueEl.textContent = "—";
    if (!emo?.label) emotionTextEl.textContent = "—";
    setStatus("connected (analyzing…)", "warn");
    setIdle(true);
    lastBpm = null;
    lastGoodAt = Date.now();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    const isStale = !lastGoodAt || now - lastGoodAt > STALE_AFTER_MS;

    setStatus(demoMode ? "demo (emotion)" : "reconnecting…", "warn");
    setError(`Backend unavailable.\n${msg}`);

    if (isStale && typeof lastBpm !== "number") {
      setIdle(true);
      return;
    }

    if (typeof lastBpm === "number") {
      document.documentElement.style.setProperty("--beat", `${bpmToBeatSeconds(lastBpm)}s`);
      setIdle(false);
    } else {
      setIdle(true);
    }
  }
}

function connect() {
  if (timer) window.clearInterval(timer);
  timer = null;

  demoMode = false;
  stopAttackMode();
  clearPersistedDemoEmotion();
  void bridgeClearEmotion();

  setStatus("connecting…", "muted");
  setError("");
  setIdle(true);
  lastGoodAt = 0;
  lastBpm = null;
  emotionTextEl.textContent = "—";
  bpmValueEl.textContent = "—";

  // Fetch immediately, then poll.
  void fetchFromClaudiacOnce();
  timer = window.setInterval(fetchFromClaudiacOnce, 1200);
}

connectBtn.addEventListener("click", connect);

renderDemoButtons();
{
  const persisted = readPersistedDemoEmotionId();
  const emo = persisted ? EMOTIONS.find((e) => e.id === persisted) : null;
  if (emo) applyEmotionDemo(emo);
  else connect();
}

ecgSourceEl.addEventListener("change", () => connect());

