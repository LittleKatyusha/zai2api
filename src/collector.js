// src/collector.js — Playwright deviceToken collector with stealth plugin
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const TokenStore = require('./db');
const config = require('./config');

chromium.use(StealthPlugin());

const ZAI_URL = 'https://chat.z.ai';

function findExecutablePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }

  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c;
    }
  } else if (process.platform === 'linux') {
    const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }

  // Fallback to Playwright's bundled Chromium
  return undefined;
}

async function launchBrowser(headless = true, proxy = '') {
  const launchOpts = {
    headless: headless,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
  };

  const execPath = findExecutablePath();
  if (execPath) {
    launchOpts.executablePath = execPath;
  }

  if (proxy) {
    launchOpts.proxy = { server: proxy };
  }

  return chromium.launch(launchOpts);
}

async function collectTokens(opts = {}) {
  const count = opts.count || config.tokenBatch || 150;
  const dbPath = opts.dbPath || config.dbPath;
  const headless = opts.headless !== false;
  const proxy = opts.proxy || config.httpsProxy || config.httpProxy || '';

  console.log(`[Collector] Starting token collection (target: ${count} tokens)...`);
  if (proxy) {
    console.log(`[Collector] Using proxy: ${proxy.replace(/:\/\/[^@]+@/, '://***@')}`);
  }

  let browser;
  try {
    browser = await launchBrowser(headless, proxy);
  } catch (err) {
    console.error('[Collector] Failed to launch browser:', err.message);
    throw err;
  }

  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      console.log(`[Collector] Attempt ${attempt} of 5...`);
      try {
        const validTokens = await runCollectionPage(browser, count);
        if (validTokens && validTokens.length > 0) {
          const store = new TokenStore(dbPath);
          store.insertBatch(validTokens);
          const totalInDb = store.count();
          store.close();
          console.log(
            `[Collector] ✅ Successfully saved ${validTokens.length} tokens to ${dbPath} (total: ${totalInDb})`
          );
          return validTokens.length;
        }
      } catch (err) {
        console.warn(`[Collector] Attempt ${attempt} failed: ${err.message}`);
        if (attempt === 5) {
          throw err;
        }
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
  return 0;
}

async function runCollectionPage(browser, count) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
    const origQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(parameters);
  });

  const page = await ctx.newPage();

  console.log('  Navigating to chat.z.ai...');
  await page.goto(ZAI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#chat-input', { timeout: 60000 });
  console.log('  Chat input found');

  // Trigger captcha SDK
  await page.fill('#chat-input', '__');
  await page.evaluate(() => {
    const btn = document.querySelector('#send-message-button');
    if (btn) btn.click();
  });
  console.log('  Send clicked');

  console.log('  Waiting for token endpoint (window.z_um.getToken)...');
  await page.waitForFunction(
    () => typeof window.z_um !== 'undefined' && typeof window.z_um.getToken === 'function',
    null,
    { timeout: 90000, polling: 100 }
  );

  console.log('  Collecting tokens...');
  const t0 = Date.now();
  const perCallTimeout = 10000;
  const tokens = await page.evaluate(
    async ({ total, perCallTimeout }) => {
      const withTimeout = (p) =>
        Promise.race([
          Promise.resolve(p),
          new Promise((r) => setTimeout(() => r(null), perCallTimeout)),
        ]);
      const out = [];
      for (let i = 0; i < total; i++) {
        try {
          out.push(await withTimeout(window.z_um.getToken()));
        } catch (e) {
          out.push(null);
        }
      }
      return out;
    },
    { total: count, perCallTimeout }
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  const valid = (tokens || []).filter((t) => {
    if (!t || typeof t !== 'string') return false;
    const s = t.trim();
    if (!s.startsWith('U0dfV0VC')) return false; // base64("SG_WEB#")
    if (s.length < 30) return false;
    return true;
  });

  console.log(`  Collected ${valid.length} valid tokens in ${elapsed}s`);
  if (valid.length === 0) {
    throw new Error('no valid tokens collected (received empty values)');
  }

  await ctx.close();
  return valid;
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
  };

  const count = parseInt(getArg('--count', '150'), 10);
  const out = getArg('--out', config.dbPath);
  const headless = getArg('--headless', 'true') !== 'false';
  const proxy = getArg('--proxy', config.httpsProxy || config.httpProxy || '');

  collectTokens({ count, dbPath: out, headless, proxy })
    .then((n) => {
      console.log(`Finished collecting ${n} tokens.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Fatal collector error:', err.message);
      process.exit(1);
    });
}

module.exports = {
  collectTokens,
};
