/**
 * AXEROCAM v2 — script.js
 * ─────────────────────────────────────────────────────────────────────────────
 * UPGRADES IN THIS VERSION:
 *  • Changed-pixel-ratio algorithm (far more sensitive than averaged delta)
 *  • setInterval-based loop at 250 ms (predictable, not rAF)
 *  • Fixed 320×240 detection canvas (fast on low-end Android)
 *  • 2-second capture cooldown (continuous capture while motion persists)
 *  • Continuous motion tracker → 60-second ALARM state
 *  • Alarm: repeated Telegram text alert every 5 seconds
 *  • Status indicators: 🟢 Monitoring / 🟡 Motion / 🔴 Alarm
 *  • Last-capture timestamp shown on HUD
 *  • Alarm resets automatically when motion stops for 3+ seconds
 *  • Live motion intensity bar on HUD
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// DOM REFERENCES
// ═══════════════════════════════════════════════════════════════════════════════

const video         = document.getElementById('video');
const canvas        = document.getElementById('canvas');
const ctx           = canvas.getContext('2d', { willReadFrequently: true });
const motionFlash   = document.getElementById('motion-flash');
const statusLine    = document.getElementById('status-line');
const logPanel      = document.getElementById('log-panel');
const clockEl       = document.getElementById('clock');
const sensSlider    = document.getElementById('sensitivity');
const sensValue     = document.getElementById('sens-value');
const permError     = document.getElementById('perm-error');
const galleryGrid   = document.getElementById('gallery-grid');
const lastCaptureEl = document.getElementById('last-capture');
const alarmOverlay  = document.getElementById('alarm-overlay');
const motionBarFill = document.getElementById('motion-bar-fill');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION  (tune these constants to change behaviour)
// ═══════════════════════════════════════════════════════════════════════════════

const CFG = {
  // Detection canvas size — smaller = faster. 320x240 is plenty.
  DETECT_W:           320,
  DETECT_H:           240,

  // A pixel is "changed" if its average RGB delta > this value (0–255).
  // 20 is a good default — ignores minor sensor noise but catches real movement.
  PER_PIXEL_THRESH:   20,

  // How often we run the detection comparison (milliseconds)
  DETECT_INTERVAL:    250,

  // Minimum gap between two screenshot uploads (milliseconds)
  CAPTURE_COOLDOWN:   2000,

  // If no motion is detected for this long, reset the continuous-motion timer
  MOTION_RESET_GAP:   3000,

  // Duration of continuous motion before ALARM is triggered
  ALARM_AFTER_MS:     60000,

  // In alarm state: send a Telegram text alert this often
  ALARM_MSG_INTERVAL: 5000,

  // Max log lines shown on screen at once
  LOG_MAX:            7,
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let stream          = null;    // MediaStream from getUserMedia
let facingMode      = 'environment';
let monitoring      = false;   // is the detection interval running?
let detectTimer     = null;    // setInterval handle
let prevFrameData   = null;    // ImageData from previous detection tick

// Capture state
let lastCaptureTime = 0;       // ms timestamp of last successful upload
let isSending       = false;   // true while an upload is in progress

// Continuous motion tracking
let motionActive    = false;   // is motion currently happening?
let motionStartTime = 0;       // when did the current motion sequence begin?
let lastMotionTime  = 0;       // timestamp of the last detected motion tick

// Alarm state
let alarmActive     = false;   // are we in ALARM mode?
let alarmMsgTimer   = null;    // setInterval handle for repeated alarm messages

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

const sleep   = (ms) => new Promise(r => setTimeout(r, ms));

/** Returns current time as HH:MM:SS string */
const timeStr = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// ═══════════════════════════════════════════════════════════════════════════════
// CLOCK
// ═══════════════════════════════════════════════════════════════════════════════

function startClock() {
  const tick = () => { clockEl.textContent = timeStr(); };
  tick();
  setInterval(tick, 1000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Appends a styled terminal-style log line to the on-screen panel.
 * @param {string} prefix  e.g. '[ALERT]'
 * @param {string} message
 * @param {string} [cls]   CSS modifier: 'alert-log' | 'sent-log' | 'alarm-log'
 */
function addLog(prefix, message, cls = '') {
  const entry = document.createElement('div');
  entry.className = `log-entry${cls ? ' ' + cls : ''}`;
  entry.textContent = `${prefix} ${message}`;
  logPanel.appendChild(entry);

  // Trim to max visible lines
  while (logPanel.children.length > CFG.LOG_MAX) {
    logPanel.removeChild(logPanel.firstChild);
  }

  // Fade out after 9 s
  setTimeout(() => {
    entry.style.transition = 'opacity 0.5s';
    entry.style.opacity    = '0';
    setTimeout(() => entry.remove(), 500);
  }, 9000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS INDICATORS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Updates the HUD status line and its colour state.
 * @param {'monitoring'|'motion'|'alarm'|'stopped'} state
 */
function setStatus(state) {
  // Strip all state classes, apply the new one
  statusLine.className = 'status-state status-' + state;

  switch (state) {
    case 'monitoring':
      statusLine.textContent = '🟢 MONITORING ACTIVE';
      break;
    case 'motion':
      statusLine.textContent = '🟡 MOTION DETECTED';
      break;
    case 'alarm':
      statusLine.textContent = '🔴 ALARM — CONTINUOUS MOTION';
      break;
    case 'stopped':
      statusLine.textContent = '⚫ MONITORING STOPPED';
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAMERA SETUP
// ═══════════════════════════════════════════════════════════════════════════════

async function startCamera(facing = 'environment') {
  // Stop previous stream if any
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: facing,
        width:      { ideal: 1280 },
        height:     { ideal: 720 },
      },
      audio: false,
    });

    video.srcObject = stream;
    video.classList.toggle('rear', facing === 'environment');

    // Wait for video metadata before reading dimensions
    await new Promise(resolve => { video.onloadedmetadata = resolve; });
    await video.play();

    // Fixed detection canvas size — always 320×240 regardless of video resolution
    canvas.width  = CFG.DETECT_W;
    canvas.height = CFG.DETECT_H;

    permError.classList.remove('show');
    addLog('[INFO]', `Camera active (${facing})`);
    return true;
  } catch (err) {
    console.error('Camera error:', err);
    permError.classList.add('show');
    addLog('[ERROR]', `Camera: ${err.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOTION DETECTION  — CHANGED-PIXEL RATIO ALGORITHM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Counts how many pixels changed significantly between two frames.
 *
 * WHY BETTER THAN THE OLD APPROACH:
 *   Old: averaged ALL pixel deltas → result diluted to near 0 → misses real motion
 *   New: counts only pixels that ACTUALLY changed above a threshold → clear signal
 *
 * @param  {ImageData} cur   current frame
 * @param  {ImageData} prev  previous frame
 * @returns {number} 0–100 — percentage of changed pixels
 */
function computeMotionScore(cur, prev) {
  const d1    = cur.data;
  const d2    = prev.data;
  const total = d1.length / 4;  // total pixel count (RGBA → /4)
  let changed = 0;

  // Step by 8 bytes = sample every 2nd pixel (halves CPU on mobile)
  for (let i = 0; i < d1.length; i += 8) {
    const dr = Math.abs(d1[i]     - d2[i]);
    const dg = Math.abs(d1[i + 1] - d2[i + 1]);
    const db = Math.abs(d1[i + 2] - d2[i + 2]);
    if ((dr + dg + db) / 3 > CFG.PER_PIXEL_THRESH) {
      changed++;
    }
  }

  // We sampled every 2nd pixel, so effective sample count = total / 2
  return (changed / (total / 2)) * 100;
}

/**
 * Converts the slider value (1–10) to a motion threshold (% changed pixels).
 *
 * Slider 1  = HIGH sensitivity → threshold  0.4% (fires on tiny movement)
 * Slider 5  = MEDIUM           → threshold  3.5%
 * Slider 10 = LOW sensitivity  → threshold  8.0% (only large movement)
 */
function getThreshold() {
  const sens = parseInt(sensSlider.value, 10);   // 1–10
  // Linear interpolation: 1→8.0, 10→0.4
  return 8.0 - (sens - 1) * (7.6 / 9);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DETECTION LOOP  (runs every CFG.DETECT_INTERVAL ms via setInterval)
// ═══════════════════════════════════════════════════════════════════════════════

function runDetection() {
  // Skip if video not ready
  if (!monitoring || video.readyState < 2) return;

  // Draw video frame downscaled to detection canvas
  ctx.drawImage(video, 0, 0, CFG.DETECT_W, CFG.DETECT_H);
  const curFrame = ctx.getImageData(0, 0, CFG.DETECT_W, CFG.DETECT_H);

  if (prevFrameData) {
    const score     = computeMotionScore(curFrame, prevFrameData);
    const threshold = getThreshold();

    // Update the live motion bar
    updateMotionBar(score, threshold);

    if (score > threshold) {
      handleMotionDetected();
    } else {
      handleMotionAbsent();
    }
  }

  // Store frame for next comparison
  prevFrameData = curFrame;
}

/** Updates the motion intensity bar in the HUD. */
function updateMotionBar(score, threshold) {
  // Bar fills proportionally; cap visual at 20% score (very high motion)
  const pct = Math.min((score / 20) * 100, 100);
  motionBarFill.style.width = pct + '%';

  if (alarmActive) {
    motionBarFill.style.background = 'var(--red)';
  } else if (score > threshold) {
    motionBarFill.style.background = 'var(--yellow)';
  } else {
    motionBarFill.style.background = 'var(--green)';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOTION EVENT HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

/** Called each tick where motion IS above threshold. */
function handleMotionDetected() {
  const now = Date.now();
  lastMotionTime = now;

  // Start a new motion sequence if one isn't already active
  if (!motionActive) {
    motionActive    = true;
    motionStartTime = now;
    setStatus('motion');
    addLog('[ALERT]', `Motion at ${timeStr()}`, 'alert-log');
    playAlertBeep();
    flashOverlay('motion');
  }

  // Check if continuous motion has lasted 60+ seconds → ALARM
  if (!alarmActive && (now - motionStartTime) >= CFG.ALARM_AFTER_MS) {
    triggerAlarm();
  }

  // Capture a screenshot if cooldown has elapsed and no upload is in flight
  if (!isSending && (now - lastCaptureTime) >= CFG.CAPTURE_COOLDOWN) {
    captureAndSend();
  }
}

/** Called each tick where motion is BELOW threshold. */
function handleMotionAbsent() {
  if (!motionActive) return;

  const silentMs = Date.now() - lastMotionTime;

  // Only reset if motion has been absent for the full reset gap
  if (silentMs >= CFG.MOTION_RESET_GAP) {
    resetMotionState();
  }
}

/** Resets all motion tracking state back to idle. */
function resetMotionState() {
  motionActive    = false;
  motionStartTime = 0;
  lastMotionTime  = 0;

  if (alarmActive) {
    cancelAlarm();
  }

  setStatus('monitoring');
  motionBarFill.style.width = '0%';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALARM STATE
// ═══════════════════════════════════════════════════════════════════════════════

/** Enters ALARM mode after 60 s of continuous motion. */
function triggerAlarm() {
  alarmActive = true;
  setStatus('alarm');
  alarmOverlay.classList.add('active');

  addLog('[ALARM]', '⚠ 60s continuous motion — ALARM!', 'alarm-log');
  playAlarmSiren();
  flashOverlay('alarm');

  // Immediate first alert, then repeat
  sendAlarmMessage();
  alarmMsgTimer = setInterval(sendAlarmMessage, CFG.ALARM_MSG_INTERVAL);
}

/** Cancels ALARM mode and clears repeated messages. */
function cancelAlarm() {
  alarmActive = false;
  alarmOverlay.classList.remove('active');

  if (alarmMsgTimer) {
    clearInterval(alarmMsgTimer);
    alarmMsgTimer = null;
  }

  addLog('[INFO]', 'Alarm cleared — motion stopped');
}

/** Sends a text-only Telegram alert (no photo) during alarm state. */
async function sendAlarmMessage() {
  const ts = timeStr();
  addLog('[ALARM]', `Sending alarm alert ${ts}`, 'alarm-log');

  try {
    const res  = await fetch('/alert', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        text: `🚨 *AXEROCAM — ALARM STATE*\n⚠ Continuous motion detected for over 1 minute.\n🕐 Time: \`${ts}\`\n📍 Camera is still active and monitoring.`,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      addLog('[SENT]', `Alarm alert delivered at ${ts}`, 'sent-log');
    } else {
      addLog('[WARN]', `Alarm alert failed: ${data.error}`);
    }
  } catch (err) {
    addLog('[ERROR]', `Alarm send error: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREENSHOT CAPTURE & UPLOAD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Captures the current video frame at FULL resolution as a PNG Blob.
 * (Detection uses the small 320×240 canvas; captures use full resolution.)
 */
function captureFrame() {
  return new Promise(resolve => {
    const cap = document.createElement('canvas');
    cap.width  = video.videoWidth  || 1280;
    cap.height = video.videoHeight || 720;
    const c = cap.getContext('2d');

    // Un-mirror the front camera in the saved image
    if (facingMode === 'user') {
      c.translate(cap.width, 0);
      c.scale(-1, 1);
    }

    c.drawImage(video, 0, 0, cap.width, cap.height);
    cap.toBlob(resolve, 'image/png');
  });
}

/** POSTs a PNG Blob to the /upload server endpoint. */
async function uploadScreenshot(blob) {
  const form = new FormData();
  form.append('screenshot', blob, 'screenshot.png');

  const res = await fetch('/upload', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Captures one frame and sends it to the server.
 * Enforces the 2-second cooldown and blocks concurrent uploads.
 */
async function captureAndSend() {
  if (isSending) return;
  isSending       = true;
  lastCaptureTime = Date.now();

  const ts = timeStr();
  addLog('[INFO]', `Capturing at ${ts}`);

  try {
    const blob   = await captureFrame();
    const result = await uploadScreenshot(blob);

    if (result.ok) {
      addLog('[SENT]', `Screenshot sent (${result.file})`, 'sent-log');
      updateLastCapture(ts);
    } else {
      addLog('[WARN]', `Upload issue: ${result.error || 'unknown'}`);
    }
  } catch (err) {
    addLog('[ERROR]', `Upload failed: ${err.message}`);
  } finally {
    isSending = false;
  }
}

/** Manual capture from the 📸 button — ignores cooldown. */
async function manualCapture() {
  addLog('[INFO]', 'Manual capture triggered');
  const ts = timeStr();

  try {
    const blob   = await captureFrame();
    const result = await uploadScreenshot(blob);

    if (result.ok) {
      addLog('[SENT]', `Manual capture sent (${result.file})`, 'sent-log');
      updateLastCapture(ts);
      flashOverlay('success');
    } else {
      addLog('[ERROR]', `Manual failed: ${result.error}`);
    }
  } catch (err) {
    addLog('[ERROR]', `Manual error: ${err.message}`);
  }
}

/** Updates the "LAST CAPTURE: HH:MM:SS" line on the HUD. */
function updateLastCapture(ts) {
  lastCaptureEl.textContent = `LAST CAPTURE: ${ts}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VISUAL FEEDBACK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Flashes the fullscreen overlay.
 * @param {'motion'|'alarm'|'success'} type
 */
function flashOverlay(type) {
  const colours = {
    motion:  'rgba(255, 200, 0, 0.10)',
    alarm:   'rgba(255, 32, 32, 0.28)',
    success: 'rgba(0, 255, 65, 0.12)',
  };
  motionFlash.style.background = colours[type] || colours.motion;
  motionFlash.classList.add('active');
  setTimeout(() => {
    motionFlash.classList.remove('active');
    motionFlash.style.background = '';
  }, 280);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO
// ═══════════════════════════════════════════════════════════════════════════════

/** Short beep for first motion event. */
function playAlertBeep() {
  try {
    const ac   = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, ac.currentTime);
    gain.gain.setValueAtTime(0.05, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.25);
    osc.start(ac.currentTime);
    osc.stop(ac.currentTime + 0.25);
  } catch (_) { /* no audio context — skip */ }
}

/** Rising two-tone siren for alarm state. */
function playAlarmSiren() {
  try {
    const ac   = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(500,  ac.currentTime);
    osc.frequency.linearRampToValueAtTime(1100, ac.currentTime + 0.45);
    osc.frequency.linearRampToValueAtTime(500,  ac.currentTime + 0.9);
    gain.gain.setValueAtTime(0.08, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 1.0);
    osc.start(ac.currentTime);
    osc.stop(ac.currentTime + 1.0);
  } catch (_) { /* skip */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GALLERY
// ═══════════════════════════════════════════════════════════════════════════════

async function loadGallery() {
  galleryGrid.innerHTML = '<div style="padding:30px;text-align:center;opacity:0.5;letter-spacing:2px;font-size:10px;">LOADING...</div>';

  try {
    const res  = await fetch('/gallery');
    const data = await res.json();
    galleryGrid.innerHTML = '';

    if (!data.ok || !data.files.length) {
      galleryGrid.innerHTML = '<div id="gallery-empty">NO CAPTURES YET</div>';
      return;
    }

    data.files.forEach(f => {
      const item  = document.createElement('div');
      item.className = 'gallery-item';

      const img   = document.createElement('img');
      img.src      = f.url;
      img.loading  = 'lazy';
      img.alt      = f.name;
      img.addEventListener('click', () => window.open(f.url, '_blank'));

      const label = document.createElement('div');
      label.className   = 'item-time';
      label.textContent = f.name.replace('.png', '');

      item.appendChild(img);
      item.appendChild(label);
      galleryGrid.appendChild(item);
    });
  } catch (err) {
    galleryGrid.innerHTML = `<div id="gallery-empty">ERROR: ${err.message}</div>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MONITORING CONTROL
// ═══════════════════════════════════════════════════════════════════════════════

function startMonitoring() {
  if (monitoring) return;
  monitoring    = true;
  prevFrameData = null;   // force fresh baseline on next tick
  detectTimer   = setInterval(runDetection, CFG.DETECT_INTERVAL);
  setStatus('monitoring');
  addLog('[LIVE]', 'Monitoring started');
  document.getElementById('btn-stop').textContent = '■ STOP';
}

function stopMonitoring() {
  monitoring = false;
  if (detectTimer) { clearInterval(detectTimer); detectTimer = null; }
  resetMotionState();
  setStatus('stopped');
  motionBarFill.style.width = '0%';
  addLog('[INFO]', 'Monitoring stopped');
  document.getElementById('btn-stop').textContent = '▶ START';
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW SWITCHING
// ═══════════════════════════════════════════════════════════════════════════════

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SENSITIVITY SLIDER
// ═══════════════════════════════════════════════════════════════════════════════

sensSlider.addEventListener('input', () => {
  sensValue.textContent = sensSlider.value;
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUTTON EVENTS
// ═══════════════════════════════════════════════════════════════════════════════

document.getElementById('btn-camera').addEventListener('click', async () => {
  facingMode    = facingMode === 'user' ? 'environment' : 'user';
  prevFrameData = null;  // reset baseline to avoid false-positive on camera switch
  await startCamera(facingMode);
  addLog('[INFO]', `Switched to ${facingMode} camera`);
});

document.getElementById('btn-snapshot').addEventListener('click', () => {
  manualCapture();
});

document.getElementById('btn-gallery').addEventListener('click', () => {
  loadGallery();
  showView('gallery-view');
});

document.getElementById('btn-back').addEventListener('click', () => {
  showView('camera-view');
});

document.getElementById('btn-stop').addEventListener('click', () => {
  monitoring ? stopMonitoring() : startMonitoring();
});

document.getElementById('btn-alarm-dismiss').addEventListener('click', () => {
  cancelAlarm();
  addLog('[INFO]', 'Alarm manually dismissed');
});

document.getElementById('retry-btn').addEventListener('click', async () => {
  const ok = await startCamera(facingMode);
  if (ok) startMonitoring();
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN WAKE LOCK  (prevents phone from sleeping while monitoring)
// ═══════════════════════════════════════════════════════════════════════════════

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      addLog('[INFO]', 'Screen wake lock active');
    }
  } catch (_) { /* not supported on all browsers */ }
}

// Re-acquire wake lock when tab becomes visible again
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && wakeLock !== null) {
    await requestWakeLock();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════

(async () => {
  startClock();
  addLog('[INFO]', 'AXEROCAM v2 initialising...');

  const ok = await startCamera(facingMode);
  if (!ok) return;

  await requestWakeLock();

  // Check Telegram connection status
  addLog('[INFO]', 'Connecting to Telegram...');
  try {
    const status = await fetch('/status').then(r => r.json());
    if (status.botToken.includes('✓') && status.chatId.includes('✓')) {
      addLog('[SUCCESS]', 'Telegram bot connected');
    } else {
      addLog('[WARN]', 'Telegram not configured');
    }
  } catch (_) {
    addLog('[WARN]', 'Server unreachable');
  }

  startMonitoring();
})();
