# AXEROCAM 🎯
### Browser-Based Motion Detection Security System with Telegram Alerts

```
 █████╗ ██╗  ██╗███████╗██████╗  ██████╗  ██████╗ █████╗ ███╗   ███╗
██╔══██╗╚██╗██╔╝██╔════╝██╔══██╗██╔═══██╗██╔════╝██╔══██╗████╗ ████║
███████║ ╚███╔╝ █████╗  ██████╔╝██║   ██║██║     ███████║██╔████╔██║
██╔══██║ ██╔██╗ ██╔══╝  ██╔══██╗██║   ██║██║     ██╔══██║██║╚██╔╝██║
██║  ██║██╔╝ ██╗███████╗██║  ██║╚██████╔╝╚██████╗██║  ██║██║ ╚═╝ ██║
╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚═╝     ╚═╝
```

---

## Features
- 📷 Live mobile camera stream (front/rear switchable)
- 🔍 Frame-difference motion detection with adjustable sensitivity
- 📸 Burst-mode screenshot capture on motion (3 shots, 1s apart)
- 📬 Instant Telegram alerts with photo + timestamp
- 💾 Local screenshot archive with gallery viewer
- 🔊 Audio alert beep on motion
- 🌙 Screen wake lock (prevents mobile sleep)
- 🖥️ Hacker-style terminal HUD

---

## Project Structure

```
axerocam/
├── start.js          ← CLI entry point (run this)
├── server.js         ← Express backend
├── config.json       ← Saved Telegram credentials
├── package.json
├── screenshots/      ← Auto-saved PNG captures
└── public/
    ├── index.html    ← Camera UI
    └── script.js     ← Motion detection engine
```

---

## Setup

### 1. Prerequisites
- Node.js v14 or higher
- A Telegram account

### 2. Create a Telegram Bot
1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the instructions
3. Copy the **Bot Token** you receive
4. Start a chat with your new bot (send it any message)
5. Visit this URL to find your Chat ID:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
   Look for `"chat":{"id":XXXXXXXXX}` in the response

### 3. Install & Run

```bash
# Clone or download the project
cd axerocam

# Install dependencies
npm install

# Start AXEROCAM
node start
```

You will be prompted to enter your **Bot Token** and **Chat ID**.  
Credentials are saved to `config.json` — you won't be asked again next time.

### 4. Open on Mobile
```
http://localhost:3000
```
Or replace `localhost` with your machine's local IP to access from a phone on the same network:
```
http://192.168.x.x:3000
```

---

## Usage

| Button     | Action                              |
|------------|-------------------------------------|
| ⇄ FLIP CAM | Switch front/rear camera            |
| 📸 CAPTURE  | Manual screenshot + Telegram alert  |
| 🗂 GALLERY  | View all saved captures             |
| ■ STOP      | Pause/resume motion monitoring      |
| Slider     | Adjust motion sensitivity (5–60)    |

---

## How Motion Detection Works

1. Every animation frame, the video is drawn to a hidden canvas at **25% resolution** (for speed)
2. Each pixel's RGB values are compared to the previous frame
3. The average change across all sampled pixels is computed as a **score 0–100**
4. If the score exceeds the **sensitivity threshold**, motion is triggered
5. A **3-shot burst** is captured and uploaded with an **8-second cooldown** to prevent spam

---

## Telegram Alert Format

```
🚨 AXEROCAM ALERT
Motion detected at: 3/27/2026, 11:45:02 PM
📸 Screenshot captured automatically.
[attached photo]
```

---

## Tips

- **Sensitivity slider:** lower = more sensitive (detects subtle movement), higher = only triggers on large movement
- **Network access from phone:** find your computer's local IP with `ipconfig` (Windows) or `ifconfig` (Mac/Linux) and open `http://<IP>:3000` in your phone's browser
- **HTTPS for mobile camera:** Chrome on Android may block camera on non-HTTPS pages over a network. Use `localhost` or set up an SSL proxy (e.g. with `ngrok`)

---

## Running with ngrok (for HTTPS / remote access)

```bash
# In a second terminal
npx ngrok http 3000
```
Open the `https://xxxxx.ngrok.io` URL on your phone — camera will work over HTTPS.

---

## License
MIT — free to use, modify, and deploy.
