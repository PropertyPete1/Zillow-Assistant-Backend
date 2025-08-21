/* eslint-disable no-console */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

try {
  const abs = path.resolve(process.cwd(), '.cache/puppeteer');
  ensureDir(abs);
  console.log('[postinstall] Installing Chrome into', abs);
  execSync('npx puppeteer browsers install chrome --platform=linux', {
    stdio: 'inherit',
    env: {
      ...process.env,
      PUPPETEER_CACHE_DIR: abs,
      PUPPETEER_DOWNLOAD_PATH: abs,
    },
  });
  console.log('[postinstall] Chrome installed.');
} catch (e) {
  console.error('[postinstall] Chrome install failed:', e?.message || e);
  process.exit(1);
}


