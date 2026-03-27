/**
 * AXEROCAM - start.js
 * CLI entry point: prompts for Telegram config, saves it, then launches server
 */

'use strict';

const inquirer = require('inquirer');
const chalk    = require('chalk');
const fs       = require('fs');
const path     = require('path');
const { execSync, spawn } = require('child_process');

// ─── ASCII Banner ────────────────────────────────────────────────────────────

function printBanner() {
  console.clear();
  console.log(chalk.greenBright(`
 █████╗ ██╗  ██╗███████╗██████╗  ██████╗  ██████╗ █████╗ ███╗   ███╗
██╔══██╗╚██╗██╔╝██╔════╝██╔══██╗██╔═══██╗██╔════╝██╔══██╗████╗ ████║
███████║ ╚███╔╝ █████╗  ██████╔╝██║   ██║██║     ███████║██╔████╔██║
██╔══██║ ██╔██╗ ██╔══╝  ██╔══██╗██║   ██║██║     ██╔══██║██║╚██╔╝██║
██║  ██║██╔╝ ██╗███████╗██║  ██║╚██████╔╝╚██████╗██║  ██║██║ ╚═╝ ██║
╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚═╝     ╚═╝
`));
  console.log(chalk.cyan('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.cyan('       Motion Detection Security System  |  Telegram Alert Engine'));
  console.log(chalk.cyan('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
}

// ─── Logger ──────────────────────────────────────────────────────────────────

const log = {
  info:    (msg) => console.log(chalk.cyan(`  [INFO]    `) + chalk.white(msg)),
  success: (msg) => console.log(chalk.greenBright(`  [SUCCESS] `) + chalk.white(msg)),
  warn:    (msg) => console.log(chalk.yellow(`  [WARN]    `) + chalk.white(msg)),
  error:   (msg) => console.log(chalk.red(`  [ERROR]   `) + chalk.white(msg)),
  alert:   (msg) => console.log(chalk.redBright(`  [ALERT]   `) + chalk.white(msg)),
  sent:    (msg) => console.log(chalk.magenta(`  [SENT]    `) + chalk.white(msg)),
  live:    (msg) => console.log(chalk.greenBright(`  [LIVE]    `) + chalk.white(msg)),
};

// ─── Ensure required directories exist ───────────────────────────────────────

function ensureDirs() {
  const dirs = [
    path.join(__dirname, 'screenshots'),
    path.join(__dirname, 'public'),
  ];
  dirs.forEach(d => {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      log.info(`Created directory: ${d}`);
    }
  });
}

// ─── Load or prompt for config ───────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');

async function loadOrPromptConfig() {
  // If config already exists, ask if user wants to reuse it
  if (fs.existsSync(CONFIG_PATH)) {
    const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (existing.botToken && existing.chatId) {
      const { reuse } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'reuse',
          message: chalk.yellow('Existing config found. Use saved Telegram credentials?'),
          default: true,
        },
      ]);
      if (reuse) return existing;
    }
  }

  // Prompt for new credentials
  console.log('\n' + chalk.yellow('  ┌─ Telegram Configuration ───────────────────────────────────┐'));
  console.log(chalk.yellow('  │  Create a bot via @BotFather on Telegram to get a token.   │'));
  console.log(chalk.yellow('  │  Send a message to your bot, then visit:                   │'));
  console.log(chalk.yellow('  │  https://api.telegram.org/bot<TOKEN>/getUpdates            │'));
  console.log(chalk.yellow('  │  to find your Chat ID.                                     │'));
  console.log(chalk.yellow('  └────────────────────────────────────────────────────────────┘\n'));

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'botToken',
      message: chalk.cyan('  Enter your Telegram Bot Token:'),
      validate: (v) => v.trim().length > 10 ? true : 'Please enter a valid bot token.',
    },
    {
      type: 'input',
      name: 'chatId',
      message: chalk.cyan('  Enter your Telegram Chat ID:'),
      validate: (v) => v.trim().length > 0 ? true : 'Chat ID cannot be empty.',
    },
    {
      type: 'number',
      name: 'port',
      message: chalk.cyan('  Server port (default 3000):'),
      default: 3000,
    },
  ]);

  const config = {
    botToken: answers.botToken.trim(),
    chatId:   answers.chatId.trim(),
    port:     answers.port || 3000,
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  log.success('Configuration saved to config.json');
  return config;
}

// ─── Test Telegram connection ─────────────────────────────────────────────────

async function testTelegram(config) {
  log.info('Connecting to Telegram...');
  try {
    const fetch = require('node-fetch');
    const res = await fetch(
      `https://api.telegram.org/bot${config.botToken}/getMe`
    );
    const data = await res.json();
    if (data.ok) {
      log.success(`Bot connected → @${data.result.username}`);
      return true;
    } else {
      log.error(`Telegram error: ${data.description}`);
      return false;
    }
  } catch (err) {
    log.error(`Cannot reach Telegram: ${err.message}`);
    return false;
  }
}

// ─── Launch Express server ────────────────────────────────────────────────────

function startServer(config) {
  log.info(`Starting AXEROCAM server on port ${config.port}...`);

  // Pass config to server via environment variables
  const env = {
    ...process.env,
    AXEROCAM_BOT_TOKEN: config.botToken,
    AXEROCAM_CHAT_ID:   config.chatId,
    AXEROCAM_PORT:      String(config.port),
  };

  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env,
    stdio: 'inherit', // pipe server logs to this terminal
  });

  server.on('error', (err) => {
    log.error(`Failed to start server: ${err.message}`);
  });

  server.on('close', (code) => {
    if (code !== 0) log.error(`Server exited with code ${code}`);
  });

  // Give server a moment to start, then print access URL
  setTimeout(() => {
    console.log('');
    log.live(`Monitoring UI ready → http://localhost:${config.port}`);
    log.info('Open the URL above on your mobile browser to start monitoring.');
    console.log('\n' + chalk.greenBright('  ● ') + chalk.white('AXEROCAM is armed. Motion will trigger Telegram alerts.\n'));
    console.log(chalk.gray('  Press Ctrl+C to stop.\n'));
  }, 1500);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  printBanner();
  ensureDirs();

  const config = await loadOrPromptConfig();
  console.log('');

  const ok = await testTelegram(config);
  if (!ok) {
    log.warn('Telegram test failed — alerts may not work. Starting anyway...');
  }

  console.log('');
  startServer(config);
})();
