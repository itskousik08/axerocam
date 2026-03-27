/**
 * AXEROCAM - server.js
 * Express server: serves frontend, receives motion screenshots, forwards to Telegram
 */

'use strict';

const express  = require('express');
const multer   = require('multer');
const axios    = require('axios');
const FormData = require('form-data');
const fs       = require('fs');
const path     = require('path');
const chalk    = require('chalk');

// ─── Config from environment (set by start.js) ────────────────────────────────

const BOT_TOKEN = process.env.AXEROCAM_BOT_TOKEN;
const CHAT_ID   = process.env.AXEROCAM_CHAT_ID;
const PORT      = parseInt(process.env.AXEROCAM_PORT || '3000', 10);

// ─── Logger ──────────────────────────────────────────────────────────────────

const log = {
  info:    (msg) => console.log(chalk.cyan(`  [INFO]    `) + chalk.white(msg)),
  success: (msg) => console.log(chalk.greenBright(`  [SUCCESS] `) + chalk.white(msg)),
  warn:    (msg) => console.log(chalk.yellow(`  [WARN]    `) + chalk.white(msg)),
  error:   (msg) => console.log(chalk.red(`  [ERROR]   `) + chalk.white(msg)),
  alert:   (msg) => console.log(chalk.redBright(`  [ALERT]   `) + chalk.white(msg)),
  sent:    (msg) => console.log(chalk.magenta(`  [SENT]    `) + chalk.white(msg)),
};

// ─── Screenshots directory ────────────────────────────────────────────────────

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

// ─── Multer — store uploads as timestamped PNGs ───────────────────────────────

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, SCREENSHOTS_DIR),
  filename:    (_req, _file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${ts}.png`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB max

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Serve screenshots gallery statically ──────────────────────────────────────
app.use('/screenshots', express.static(SCREENSHOTS_DIR));

// ─── POST /upload ─────────────────────────────────────────────────────────────
/**
 * Receives a motion-detected screenshot from the browser.
 * Saves it to disk and forwards it to Telegram.
 */
app.post('/upload', upload.single('screenshot'), async (req, res) => {
  if (!req.file) {
    log.warn('Upload endpoint hit but no file received.');
    return res.status(400).json({ ok: false, error: 'No file uploaded.' });
  }

  const filePath  = req.file.path;
  const fileName  = req.file.filename;
  const timestamp = new Date().toLocaleString();

  log.alert(`Motion detected — screenshot saved: ${fileName}`);

  // Send to Telegram
  try {
    await sendToTelegram(filePath, timestamp);
    log.sent(`Screenshot delivered to Telegram chat ${CHAT_ID}`);
    return res.json({ ok: true, file: fileName });
  } catch (err) {
    log.error(`Telegram delivery failed: ${err.message}`);
    // Still return 200 — file is saved locally even if Telegram fails
    return res.json({ ok: false, file: fileName, error: err.message });
  }
});

// ─── GET /gallery ─────────────────────────────────────────────────────────────
/**
 * Returns a JSON list of saved screenshots for the gallery page.
 */
app.get('/gallery', (_req, res) => {
  try {
    const files = fs.readdirSync(SCREENSHOTS_DIR)
      .filter(f => f.endsWith('.png'))
      .sort()
      .reverse()
      .map(f => ({
        name: f,
        url:  `/screenshots/${f}`,
        time: f.replace('.png', '').replace(/-/g, (m, i) => i === 10 ? 'T' : i > 10 ? (i === 13 || i === 16 ? ':' : '.') : '-'),
      }));
    res.json({ ok: true, files });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /status ──────────────────────────────────────────────────────────────
app.get('/status', (_req, res) => {
  res.json({
    ok:       true,
    service:  'AXEROCAM',
    uptime:   process.uptime(),
    chatId:   CHAT_ID ? '✓ configured' : '✗ missing',
    botToken: BOT_TOKEN ? '✓ configured' : '✗ missing',
  });
});

// ─── Telegram helper ──────────────────────────────────────────────────────────

/**
 * Sends a photo file to Telegram using sendPhoto API.
 * Retries once on failure.
 */
async function sendToTelegram(filePath, timestamp, attempt = 1) {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error('Bot token or Chat ID not configured.');
  }

  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('caption',
    `🚨 *AXEROCAM ALERT*\n` +
    `Motion detected at: \`${timestamp}\`\n` +
    `📸 Screenshot captured automatically.`,
    { contentType: 'text/plain' }
  );
  form.append('parse_mode', 'Markdown');
  form.append('photo', fs.createReadStream(filePath), {
    filename:    path.basename(filePath),
    contentType: 'image/png',
  });

  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`,
      form,
      { headers: form.getHeaders(), timeout: 15000 }
    );
    if (!response.data.ok) {
      throw new Error(response.data.description || 'Unknown Telegram error');
    }
  } catch (err) {
    if (attempt < 2) {
      log.warn(`Telegram retry attempt ${attempt + 1}...`);
      await new Promise(r => setTimeout(r, 2000));
      return sendToTelegram(filePath, timestamp, attempt + 1);
    }
    throw err;
  }
}

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log.success(`AXEROCAM server running on http://localhost:${PORT}`);
  log.info('Waiting for motion events from browser...');
});
