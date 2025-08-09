import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

export async function launchBrowser() {
  const execPath = await chromium.executablePath();
  return puppeteer.launch({
    headless: true,
    executablePath: execPath,
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });
}


