/**
 * AXEROCAM — script.js
 * Motion detection engine, camera management, screenshot upload, gallery, UI
 */

'use strict';

// ─── DOM References ───────────────────────────────────────────────────────────

const video       = document.getElementById('video');
const canvas      = document.getElementById('canvas');
const ctx         = canvas.getContext('2d', { willReadFrequently: true });
const motionFlash = document.getElementById('motion-flash');
const statusLine  = document.getElementById('status-line');
const logPanel    = document.getElementById('log-panel');
const clock       = document.getElementById('clock');
const sensSlider  = document.getElementById('sensitivity');
const sensValue   = document.getElementById('sens-value');
const permError   = document.getElementById('perm-error');
const cameraView  = document.getElementById('camera-view');
const galleryView = document.getElementById('gallery-view');
const galleryGrid = document.getElementById('gallery-grid');

// ─── State ────────────────────────────────────────────────────────────────────

let stream        = null;        // MediaStream
let facingMode    = 'environment'; // 'user' = front, 'environment' = rear
let monitoring    = false;       // is the detection loop running?
let animFrameId   = null;        // requestAnimationFrame handle
let prevFrameData = null;        // pixel data from previous frame
let lastAlert     = 0;           // timestamp of last Telegram upload
let isSending     = false;       // prevent concurrent uploads
let burstCount    = 0;           // burst mode counter

// ─── Config ───────────────────────────────────────────────────────────────────

const COOLDOWN_MS      = 8000;   // 8 s between alerts
const BURST_SHOTS      = 3;      // number of burst captures
const BURST_DELAY_MS   = 1000;   // delay between burst captures
const DETECTION_SCALE  = 0.25;   // downscale factor for speed
const LOG_MAX          = 6;      // max log lines shown

// ─── Utility: sleep ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Clock ────────────────────────────────────────────────────────────────────

function startClock() {
  const update = () => {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    clock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  };
  update();
  setInterval(update, 1000);
}

// ─── Terminal-style logger ────────────────────────────────────────────────────

function addLog(prefix, message, type = '') {
  const entry = document.createElement('div');
  entry.className = `log-entry${type ? ' ' + type : ''}`;
  entry.textContent = `${prefix} ${message}`;
  logPanel.appendChild(entry);

  // Keep only LOG_MAX lines
  while (logPanel.children.length > LOG_MAX) {
    logPanel.removeChild(logPanel.firstChild);
  }

  // Auto-remove old entries after 8 s
  setTimeout(() => {
    entry.style.opacity = '0';
    entry.style.transition = 'opacity 0.5s';
    setTimeout(() => entry.remove(), 500);
  }, 8000);
}

// ─── Camera Setup ────────────────────────────────────────────────────────────

async function startCamera(facing = 'environment') {
  // Stop any existing stream
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  const constraints = {
    video: {
      facingMode: facing,
      width:  { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;

    // Mirror front cam, don't mirror rear cam
    video.classList.toggle('rear', facing === 'environment');

    await new Promise(resolve => { video.onloadedmetadata = resolve; });
    video.play();

    // Size the hidden canvas to a downscaled version for speed
    canvas.width  = Math.round(video.videoWidth  * DETECTION_SCALE);
    canvas.height = Math.round(video.videoHeight * DETECTION_SCALE);

    permError.classList.remove('show');
    addLog('[INFO]', 'Camera stream active');
    return true;
  } catch (err) {
    console.error('Camera error:', err);
    permError.classList.add('show');
    addLog('[ERROR]', `Camera: ${err.message}`);
    return false;
  }
}

// ─── Motion Detection ─────────────────────────────────────────────────────────

/**
 * Returns a score 0–100 representing how much pixel-level change
 * occurred between the current frame and the previous frame.
 */
function computeMotionScore(currentData, previousData) {
  const len   = currentData.data.length;
  let   total = 0;

  // Compare every 4th pixel (skip alpha) for performance
  for (let i = 0; i < len; i += 16) {
    const dr = Math.abs(currentData.data[i]     - previousData.data[i]);
    const dg = Math.abs(currentData.data[i + 1] - previousData.data[i + 1]);
    const db = Math.abs(currentData.data[i + 2] - previousData.data[i + 2]);
    // Average colour distance, normalised to 0–1
    total += (dr + dg + db) / 3 / 255;
  }

  // Number of sampled pixels
  const sampleCount = len / 16;
  return (total / sampleCount) * 100;
}

/**
 * Main detection loop — runs via requestAnimationFrame.
 */
function detectionLoop() {
  if (!monitoring) return;

  // Draw current frame (downscaled) to hidden canvas
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const currentFrame = ctx.getImageData(0, 0, canvas.width, canvas.height);

  if (prevFrameData) {
    const score     = computeMotionScore(currentFrame, prevFrameData);
    const threshold = parseInt(sensSlider.value, 10) / 4; // map 5–60 → ~1.25–15

    if (score > threshold) {
      onMotionDetected();
    }
  }

  prevFrameData = currentFrame;
  animFrameId = requestAnimationFrame(detectionLoop);
}

/**
 * Called when motion exceeds threshold.
 */
function onMotionDetected() {
  const now = Date.now();

  // Flash the red overlay
  motionFlash.classList.add('active');
  setTimeout(() => motionFlash.classList.remove('active'), 200);

  // Update status text
  statusLine.textContent = '⚠ MOTION DETECTED';
  statusLine.classList.add('alert');
  setTimeout(() => {
    statusLine.textContent = '◉ MONITORING ACTIVE';
    statusLine.classList.remove('alert');
  }, 2000);

  addLog('[ALERT]', 'Motion detected — preparing capture', 'alert-log');

  // Honour cooldown
  if (isSending || now - lastAlert < COOLDOWN_MS) return;

  // Play alert sound
  playAlertBeep();

  // Trigger burst capture
  captureAndSendBurst();
}

// ─── Screenshot Capture ───────────────────────────────────────────────────────

/**
 * Captures the current video frame as a PNG Blob.
 * Uses full-resolution canvas for best quality.
 */
function captureFrame() {
  return new Promise((resolve) => {
    const captureCanvas = document.createElement('canvas');
    captureCanvas.width  = video.videoWidth  || 1280;
    captureCanvas.height = video.videoHeight || 720;

    const captureCtx = captureCanvas.getContext('2d');

    // Un-mirror front camera for the saved image
    if (facingMode === 'user') {
      captureCtx.translate(captureCanvas.width, 0);
      captureCtx.scale(-1, 1);
    }

    captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
    captureCanvas.toBlob(resolve, 'image/png');
  });
}

/**
 * Uploads a PNG Blob to the /upload endpoint.
 */
async function uploadScreenshot(blob) {
  const formData = new FormData();
  formData.append('screenshot', blob, 'screenshot.png');

  const response = await fetch('/upload', {
    method: 'POST',
    body:   formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Server error ${response.status}: ${text}`);
  }

  return response.json();
}

/**
 * Captures BURST_SHOTS frames and uploads each one.
 */
async function captureAndSendBurst() {
  if (isSending) return;
  isSending = true;
  lastAlert = Date.now();

  for (let i = 0; i < BURST_SHOTS; i++) {
    try {
      const blob = await captureFrame();
      addLog('[INFO]', `Sending capture ${i + 1}/${BURST_SHOTS}...`);

      const result = await uploadScreenshot(blob);

      if (result.ok) {
        addLog('[SENT]', `Screenshot delivered (${result.file})`, 'sent-log');
      } else {
        addLog('[WARN]', `Upload issue: ${result.error || 'unknown'}`);
      }
    } catch (err) {
      addLog('[ERROR]', `Upload failed: ${err.message}`);
    }

    if (i < BURST_SHOTS - 1) await sleep(BURST_DELAY_MS);
  }

  isSending = false;
}

/**
 * Manual snapshot (triggered by Capture button).
 */
async function manualCapture() {
  addLog('[INFO]', 'Manual capture triggered');
  const blob   = await captureFrame();
  const result = await uploadScreenshot(blob).catch(e => ({ ok: false, error: e.message }));

  if (result.ok) {
    addLog('[SENT]', `Manual capture sent (${result.file})`, 'sent-log');
    // Visual confirmation flash
    motionFlash.style.background = 'rgba(0,255,65,0.15)';
    motionFlash.classList.add('active');
    setTimeout(() => {
      motionFlash.classList.remove('active');
      motionFlash.style.background = '';
    }, 300);
  } else {
    addLog('[ERROR]', `Manual capture failed: ${result.error}`);
  }
}

// ─── Alert Beep ───────────────────────────────────────────────────────────────

function playAlertBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch (_) {
    // Audio context may not be available — silently skip
  }
}

// ─── Gallery ──────────────────────────────────────────────────────────────────

async function loadGallery() {
  galleryGrid.innerHTML = '';

  try {
    const res   = await fetch('/gallery');
    const data  = await res.json();

    if (!data.ok || !data.files.length) {
      galleryGrid.innerHTML = '<div id="gallery-empty">NO CAPTURES YET</div>';
      return;
    }

    data.files.forEach(f => {
      const item = document.createElement('div');
      item.className = 'gallery-item';

      const img = document.createElement('img');
      img.src     = f.url;
      img.loading = 'lazy';
      img.alt     = f.name;

      // Tap to open full image
      img.addEventListener('click', () => window.open(f.url, '_blank'));

      const timeLabel = document.createElement('div');
      timeLabel.className   = 'item-time';
      timeLabel.textContent = f.name.replace('.png', '').replace(/-/g, (m, i) => i < 10 ? '-' : ':');

      item.appendChild(img);
      item.appendChild(timeLabel);
      galleryGrid.appendChild(item);
    });
  } catch (err) {
    galleryGrid.innerHTML = `<div id="gallery-empty">ERROR: ${err.message}</div>`;
  }
}

// ─── View Switching ───────────────────────────────────────────────────────────

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ─── Sensitivity Slider ───────────────────────────────────────────────────────

sensSlider.addEventListener('input', () => {
  sensValue.textContent = sensSlider.value;
});

// ─── Button Events ────────────────────────────────────────────────────────────

// Flip camera
document.getElementById('btn-camera').addEventListener('click', async () => {
  facingMode = facingMode === 'user' ? 'environment' : 'user';
  prevFrameData = null; // reset frame diff to avoid false positive on switch
  await startCamera(facingMode);
  addLog('[INFO]', `Camera switched to: ${facingMode}`);
});

// Manual capture
document.getElementById('btn-snapshot').addEventListener('click', () => {
  manualCapture();
});

// Gallery
document.getElementById('btn-gallery').addEventListener('click', () => {
  loadGallery();
  showView('gallery-view');
});

// Back from gallery
document.getElementById('btn-back').addEventListener('click', () => {
  showView('camera-view');
});

// Stop / Start toggle
document.getElementById('btn-stop').addEventListener('click', () => {
  if (monitoring) {
    monitoring = false;
    cancelAnimationFrame(animFrameId);
    statusLine.textContent = '■ MONITORING STOPPED';
    document.getElementById('btn-stop').textContent = '▶ START';
    addLog('[INFO]', 'Monitoring stopped');
  } else {
    monitoring = true;
    prevFrameData = null;
    detectionLoop();
    statusLine.textContent = '◉ MONITORING ACTIVE';
    document.getElementById('btn-stop').textContent = '■ STOP';
    addLog('[INFO]', 'Monitoring resumed');
  }
});

// Retry camera permission
document.getElementById('retry-btn').addEventListener('click', async () => {
  const ok = await startCamera(facingMode);
  if (ok) {
    monitoring = true;
    detectionLoop();
  }
});

// ─── Prevent sleep / screen lock on mobile (if supported) ────────────────────

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      addLog('[INFO]', 'Screen wake lock acquired');
    }
  } catch (_) { /* not available */ }
}

document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    await requestWakeLock();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  startClock();
  addLog('[INFO]', 'AXEROCAM initialising...');

  const ok = await startCamera(facingMode);
  if (!ok) return;

  await requestWakeLock();

  monitoring = true;
  detectionLoop();

  addLog('[INFO]', 'Connecting to Telegram...');
  try {
    const status = await fetch('/status').then(r => r.json());
    if (status.chatId.includes('✓') && status.botToken.includes('✓')) {
      addLog('[SUCCESS]', 'Bot connected — alerts active');
    } else {
      addLog('[WARN]', 'Telegram not fully configured');
    }
  } catch (_) {
    addLog('[WARN]', 'Could not reach server');
  }

  addLog('[LIVE]', 'Monitoring started — watching for motion');
})();
