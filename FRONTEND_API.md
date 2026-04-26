# Claudiac — Frontend API spec (Demo 2: Classification)

This is the **new** API contract — the project pivoted from "mismatch
detection" to "ECG-based emotion + anomaly classification". If you've
already built UI against the old `/api/analyze` and `/api/mood`
endpoints, those are gone now. Sorry about that.

The good news: the new flow is simpler and demos better.

## What the demo does

User picks one of 10 buttons. Each button represents either an emotion
(9 buttons: anger, anxiety, fear, joy, envy, disgust, embarrassment,
ennui, sadness) or a medical anomaly (1 button: heart attack).

Clicking a button:
1. Tells the backend which scenario to run
2. Backend loads that scenario's pre-recorded ECG
3. Backend extracts HR, HRV, peak amplitude using Pan-Tompkins QRS detection
4. Backend classifies based on hard rules over a medical knowledge table
5. Backend asks Claude to write a 2-3 sentence clinical-style explanation
6. Frontend renders ECG waveform + features + classification + explanation

The headline visual is the **heart_attack** button — it should override
all other classifications with a flashing red/black alert.

## Endpoints

The backend is at `http://localhost:5000`. Three endpoints:

### `GET /api/health`

Sanity check. Returns:

```json
{
  "status": "ok",
  "service": "claudiac-backend",
  "version": "demo2-classification",
  "n_scenarios": 10
}
```

### `GET /api/scenarios`

Returns the list of all 10 scenarios with display metadata. Use this on
page load to render the 10 buttons.

```json
{
  "scenarios": [
    {
      "id": "heart_attack",
      "label": "Heart Attack",
      "color": "#FF0000",
      "color_secondary": "#000000",
      "flashing": true,
      "expected": {"hr_bpm": "ignored", "hrv_ms": "ignored", "amplitude": "erratic"},
      "physiological_why": "Medical anomaly thresholds. Overrides all other classifications.",
      "file": "heart_attack.npz"
    },
    {
      "id": "anger",
      "label": "Anger",
      "color": "#FF0000",
      "color_secondary": null,
      "flashing": false,
      "expected": {"hr_bpm": ">85", "hrv_ms": "<30", "amplitude": "high"},
      "physiological_why": "High energy, high stress, strong pounding chest.",
      "file": "anger.npz"
    }
  ],
  "knowledge_table": [ "...full medical rules table, useful for tooltips..." ]
}
```

### `GET /api/classify/<scenario_id>`

The main endpoint. Runs the full pipeline and returns everything you
need to render the screen. `<scenario_id>` is one of:
`heart_attack`, `anger`, `anxiety`, `fear`, `joy`, `envy`, `disgust`,
`embarrassment`, `ennui`, `sadness`.

**Response shape:**

```json
{
  "scenario": {
    "id": "anger",
    "label": "Anger",
    "expected": {"hr_bpm": ">85", "hrv_ms": "<30", "amplitude": "high"}
  },

  "ecg": {
    "samples_uV": [2074.07, 169.73, -455.65, "...1500 floats..."],
    "sampling_rate": 512.0,
    "duration_s": 30.0,
    "n_original_samples": 15360,
    "display_step": 10
  },

  "r_peaks_display": [42, 85, 128, "..."],

  "key_information": {
    "heart_rate_bpm": 105.1,
    "hrv_sdnn_ms": 7.2,
    "peak_amplitude_uV": 2200,
    "n_beats_detected": 52
  },

  "classification": {
    "category_id": "anger",
    "category_label": "Anger",
    "color": "#FF0000",
    "color_secondary": null,
    "flashing": false,
    "is_critical": false,
    "features": {
      "hr_bpm": 105.1,
      "hr_band": "high",
      "hrv_sdnn_ms": 7.2,
      "hrv_band": "low",
      "peak_amplitude_uV": 2200.0,
      "amplitude_band": "high"
    },
    "rules_matched": {
      "hr": "> 85",
      "hrv": "< 30",
      "amplitude": "high (pounding)"
    },
    "knowledge_table_why": "High energy, high stress, strong pounding chest.",
    "explanation": {
      "text": "The ECG demonstrates physiological markers consistent with anger: elevated heart rate at 105.1 bpm (exceeding the 85 bpm threshold), suppressed heart rate variability at 7.2 ms SDNN (below 30 ms), and high R-wave amplitude at 2200 microV indicating forceful ventricular contraction. These findings reflect sympathetic nervous system activation characteristic of high-energy emotional arousal with reduced parasympathetic modulation.",
      "source": "claude_api",
      "_usage": {"input_tokens": 257, "output_tokens": 139}
    }
  }
}
```

## Field-by-field guide

### `ecg.samples_uV`

Array of ~1500 floats representing the ECG voltage in microvolts.
Already downsampled from the original 15,360 samples for fast browser
plotting. Plot directly with Chart.js, uPlot, or D3.

X-axis: time in seconds = sample_index / sampling_rate * display_step.
Or just use sample index — close enough for a 30s window.

### `r_peaks_display`

Array of integer indices into `samples_uV` where R-peaks were detected.
Use these to draw red dots on top of the ECG line at
`(samples_uV[r_peaks_display[i]], r_peaks_display[i])`.

**For the heart_attack scenario, this array may be empty or contain
spurious detections** — that's by design. V-fib has no organized QRS,
so the QRS detector legitimately fails. Don't crash if it's empty.

### `key_information`

The four numbers to display in a "Key Info" card. These come from the
classical signal processing layer (Pan-Tompkins), not from the LLM.
Render with proper units: bpm, ms, microV, count.

### `classification.category_id`

One of the 10 IDs. Use this to choose the card color (see
`classification.color`). For analytics/tracking if you want.

### `classification.color` / `color_secondary` / `flashing`

Display metadata for the classification card.

- **Normal categories** (9 emotions): `color` is set, `color_secondary`
  is null, `flashing` is false. Use `color` as the card background
  or accent.
- **Heart attack only**: `color` = red `#FF0000`, `color_secondary` =
  black `#000000`, `flashing` = true. Render this card with a
  flashing red/black alternation. CSS keyframes work fine — see the
  example below.

### `classification.is_critical`

Boolean — true only for heart_attack. Use this to gate any extra UI:
sound effect, full-screen alert, larger font, etc. Never silently
ignore a critical classification.

### `classification.features`

Same numbers as `key_information`, but each comes with a "band":
`low | normal | high`. Useful for showing which threshold each value
falls into. Could render as colored chips: `HR 105 (high)`,
`HRV 7 ms (low)`, `Peak 2200 uV (high)`.

### `classification.rules_matched`

The actual rules from the knowledge table that classified this case.
Useful as a small "why" tooltip: `HR > 85, HRV < 30, amp high -> Anger`.

### `classification.explanation`

The Claude-generated 2-3 sentence clinical explanation. **This is the
narrative payload.** Render it prominently — this is where the LLM
intelligence shows up to the judges.

`source` will be:
- `"claude_api"` when Claude wrote it (preferred)
- `"knowledge_table"` or `"knowledge_table (...)"` when fallback
  occurred (no API key, network error, etc.)

The text quality is night-and-day between the two. Treat the source
field as a debug indicator, but show the text either way.

## Suggested layout

```
+-------------------------------------------------------------+
|  CLAUDIAC                                                   |
|  ECG-based Emotion & Cardiac Anomaly Classifier             |
+-------------------------------------------------------------+
|                                                             |
|  Scenario buttons (10):                                     |
|  [Heart Attack] [Anger] [Anxiety] [Fear] [Joy]              |
|                 [Envy]  [Disgust] [Embarrassment]           |
|                 [Ennui] [Sadness]                           |
|                                                             |
+-------------------------------------------------------------+
|                            |                                |
|  ECG Waveform              |  KEY INFORMATION               |
|  (line chart with R-peak   |  Heart Rate     105.1 bpm  high|
|   red dots)                |  HRV (SDNN)       7.2 ms   low |
|                            |  Peak Amplitude  2200 uV   high|
|                            |  Beats Detected  52 over 30s  |
|                            +--------------------------------+
|                            |  CLASSIFICATION                |
|                            |  +-------------------------+   |
|                            |  |  ANGER                  |   |
|                            |  |  -----------------------|   |
|                            |  |  Rules matched:         |   |
|                            |  |    HR > 85 ok           |   |
|                            |  |    HRV < 30 ok          |   |
|                            |  |    Amplitude high ok    |   |
|                            |  +-------------------------+   |
|                            |  (background = #FF0000-ish)    |
|                            +--------------------------------+
|                            |  EXPLANATION                   |
|                            |  "The ECG demonstrates         |
|                            |   physiological markers        |
|                            |   consistent with anger:       |
|                            |   elevated heart rate at       |
|                            |   105.1 bpm..."                |
+----------------------------+--------------------------------+
```

This is a suggestion — you have full design freedom. But please keep
**Heart Attack visually different and unmistakably alarming** when it
fires. That contrast is the demo's most important moment.

## Color palette (from the medical table)

```
heart_attack    #FF0000  flashing red <-> #000000 black
anger           #FF0000  red
anxiety         #FF8C00  orange
fear            #8A2BE2  purple
joy             #FFD700  yellow
envy            #00CED1  teal
disgust         #32CD32  green
embarrassment   #FF69B4  pink
ennui           #3A3B5C  indigo
sadness         #4169E1  blue
```

Use these as accent colors for each scenario button and as the
classification card's primary color when matched.

## Heart attack flashing — CSS example

```css
.classification-card.is-critical {
  animation: flash-alarm 0.6s ease-in-out infinite alternate;
}

@keyframes flash-alarm {
  from { background-color: #FF0000; color: white; }
  to   { background-color: #000000; color: #FF0000; }
}
```

Add `is-critical` class to the card when `classification.is_critical`
is true. Remove on any other classification.

## Example fetch flow

```js
const BACKEND = "http://localhost:5000";

// On page load: get the list of scenarios to render buttons
async function init() {
  const res = await fetch(`${BACKEND}/api/scenarios`);
  const data = await res.json();
  renderButtons(data.scenarios);
}

// On button click: classify and render
async function onScenarioClick(scenarioId) {
  showLoading();
  const res = await fetch(`${BACKEND}/api/classify/${scenarioId}`);
  if (!res.ok) {
    showError(await res.text());
    return;
  }
  const data = await res.json();

  drawEcg(data.ecg.samples_uV, data.r_peaks_display);
  renderKeyInfo(data.key_information, data.classification.features);
  renderClassification(data.classification);
  renderExplanation(data.classification.explanation);
}

function renderClassification(cls) {
  const card = document.getElementById("classification-card");
  card.style.backgroundColor = cls.color;
  card.classList.toggle("is-critical", cls.is_critical);
  document.getElementById("category-label").textContent = cls.category_label;
  // render rules, etc.
}
```

## ECG plotting tips

- **Chart.js**: simple line chart, set `pointRadius: 0` on the ECG line
  so you don't get dots at every sample. Add a separate scatter dataset
  for R-peaks with red color.
- **uPlot**: faster for ~1500 points, smoother if you animate.
- **Plain SVG `<polyline>`**: also fine, ~10 lines of code. Map the
  array to `points` attribute.

The waveform is already downsampled, so don't downsample again.

For the heart_attack scenario, the waveform will look chaotic and have
no clean R-peaks. That's correct — let it look messy. It's the visual
proof that this isn't a normal heartbeat.

## Loading state

The Claude explanation call adds ~1-3 seconds of latency to each
request. Show a spinner or "Analyzing..." state while
`/api/classify/<id>` is in flight. Don't leave the previous result
visible — clear or fade out before the new data arrives.

## Error handling

If the backend is down or the endpoint returns an error:
- Show a non-fatal error toast/banner
- Keep the buttons clickable so the user can retry
- Don't blow up the whole page

If `classification.explanation.source` starts with `"knowledge_table"`
that means the Claude API failed silently and you're seeing the
fallback text. Still show it — the demo doesn't break — but maybe log
it to the console for debugging.

## What's deliberately not in scope

These were considered and cut for the 10-hour window:

- User-editable self-report (was in the v1 mismatch design, gone now)
- Multi-day trend charts
- Real-time streaming from a wrist sensor (Demo 1 stub will simulate this)
- Multiple users / accounts / persistence

If a judge asks about any of these, the answer is "next iteration".

## Communication

- The backend is stable. If you hit an unexpected response shape, that's
  a bug — tell Zack, don't paper over it client-side.
- F12 -> Network tab is your friend. Failed requests there will tell you
  the exact error before you debug your code.
- When you're ~60% done with the layout, send a screenshot — easier
  to catch contract mismatches early than at hour 9.

— Zack
