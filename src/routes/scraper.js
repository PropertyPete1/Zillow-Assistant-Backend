import express from 'express';

const router = express.Router();

let scraperState = {
  isRunning: false,
  lastRun: null,
  totalListings: 0,
  status: 'idle',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPuppeteer() {
  const useCore = process.env.RENDER || process.env.CHROMIUM_PATH || process.env.AWS_LAMBDA_FUNCTION_VERSION;
  if (useCore) {
    const { default: puppeteer } = await import('puppeteer-core');
    const chromium = (await import('@sparticuz/chromium')).default;
    return { puppeteer, chromium };
  }
  const { default: puppeteer } = await import('puppeteer');
  return { puppeteer, chromium: null };
}

function buildQuery(propertyType, zip) {
  const mode = propertyType === 'rent' ? 'for rent by owner' : propertyType === 'sale' ? 'for sale by owner' : 'for rent by owner';
  return `site:zillow.com ${zip} ${mode}`;
}

async function extractListings(page) {
  const items = await page.evaluate(() => {
    const results = [];
    const as = Array.from(document.querySelectorAll('a[data-test="property-card-link"], a.property-card-link, article a[href*="/homedetails/"], a[href*="/b/"], a[href*="/homedetails/"]'));
    const seen = new Set();
    for (const a of as) {
      try {
        const link = a.href;
        if (!link || seen.has(link)) continue; seen.add(link);
        const card = a.closest('article, div[data-test="property-card"], li, div');
        const address = (card?.querySelector('[data-test="property-card-addr"], [data-test="property-card-address"], address, h2, h3') as any)?.textContent?.trim?.() || a.textContent?.trim?.() || '';
        const priceText = (card?.querySelector('[data-test="property-card-price"], .PropertyCardWrapper__StyledPrice, [class*="price"]') as any)?.textContent?.trim?.() || '';
        const bedsText = (card?.querySelector('[data-test*="bed-bath"], [class*="bed"]') as any)?.textContent?.trim?.() || '';
        const bedrooms = parseInt((bedsText.match(/\d+/)||['0'])[0],10)||0;
        results.push({ address, price: priceText, bedrooms, ownerName: '', link });
      } catch {}
    }
    return results;
  });
  return items;
}

async function runZip({ puppeteer, chromium }, { propertyType, zip, filters }) {
  const start = Date.now();
  // eslint-disable-next-line no-console
  console.log(`SCRAPER start propertyType=${propertyType} zip=${zip}`);
  const args = ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--single-process','--no-zygote'];
  let browser;
  try {
    const launchOptions = { headless: 'new', args };
    if (chromium) {
      const execPath = await chromium.executablePath();
      Object.assign(launchOptions, { executablePath: execPath, defaultViewport: chromium.defaultViewport });
    }
    const { stealth } = await import('puppeteer-extra-plugin-stealth');
    const puppeteerExtra = (await import('puppeteer-extra')).default;
    puppeteerExtra.use(stealth());
    browser = await puppeteerExtra.launch(launchOptions);
    const page = await browser.newPage();
    await page.setUserAgent(`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Math.floor(120+Math.random()*5)}.0.0.0 Safari/537.36`);
    await page.setViewport({ width: 1200 + Math.floor(Math.random()*200), height: 900 + Math.floor(Math.random()*200) });

    const query = buildQuery(propertyType, zip);
    console.log(`SCRAPER ddg query="${query}"`);
    await page.goto('https://duckduckgo.com/', { timeout: 20000, waitUntil: 'domcontentloaded' });
    await sleep(300 + Math.random()*700);
    await page.type('input[name="q"]', query, { delay: 50 + Math.random()*40 });
    await Promise.all([
      page.keyboard.press('Enter'),
      page.waitForNavigation({ timeout: 20000, waitUntil: 'domcontentloaded' })
    ]);
    await sleep(300 + Math.random()*700);
    const linkHandle = await page.$('a.result__a[href*="zillow.com"]') || await page.$('a[href*="zillow.com/"]');
    if (!linkHandle) {
      console.warn('SCRAPER warning: no zillow result');
      return { listings: [], warning: 'selectors-empty', durationMs: Date.now()-start };
    }
    await Promise.all([
      linkHandle.click({ delay: 50 + Math.random()*50 }),
      page.waitForNavigation({ timeout: 20000, waitUntil: 'domcontentloaded' })
    ]);
    console.log('SCRAPER zillow click ok');
    try {
      await page.waitForSelector('a[data-test="property-card-link"], article a[href*="/homedetails/"]', { timeout: 15000 });
    } catch {
      console.warn('SCRAPER warning: cards selector not found');
    }
    await sleep(400 + Math.random()*900);
    await page.evaluate(() => { window.scrollBy(0, 800); });
    await sleep(400 + Math.random()*900);
    let rows = await extractListings(page);
    const { minBedrooms, maxPrice } = filters || {};
    rows = rows.filter(r => {
      if (minBedrooms && r.bedrooms && r.bedrooms < Number(minBedrooms)) return false;
      if (maxPrice) {
        const p = parseInt(String(r.price).replace(/[^0-9]/g, ''), 10) || 0;
        if (p && p > Number(maxPrice)) return false;
      }
      return true;
    });
    console.log(`SCRAPER extracted=${rows.length}`);
    return { listings: rows, durationMs: Date.now()-start };
  } catch (err) {
    console.warn('SCRAPER error during runZip:', err?.message || String(err));
    const msg = /captcha|403|blocked/i.test(String(err)) ? 'blocked' : 'error';
    return { listings: [], warning: msg, durationMs: Date.now()-start };
  } finally {
    try { await browser?.close(); } catch {}
    console.log(`SCRAPER finished ${Date.now()-start}ms`);
  }
}

// Preferred endpoint used by frontend
router.post('/run', async (req, res) => {
  const t0 = Date.now();
  try {
    const { propertyType = 'rent', zipCodes = [], filters = {} } = req.body || {};
    scraperState = { ...scraperState, isRunning: true, status: 'running', lastRun: new Date().toISOString() };
    console.log('SCRAPER start', { propertyType, zipCodes, filters });
    const { puppeteer, chromium } = await getPuppeteer();
    const zips = Array.isArray(zipCodes) && zipCodes.length ? zipCodes.slice(0, 2) : ['78704'];
    const all = [];
    for (const zip of zips) {
      const { listings, warning } = await runZip({ puppeteer, chromium }, { propertyType, zip, filters });
      if (warning && !listings?.length) {
        // continue but note warning in logs
      }
      all.push(...(listings || []));
      await sleep(500 + Math.random()*700);
    }
    scraperState = { ...scraperState, isRunning: false, status: 'idle', totalListings: all.length };
    return res.json({ listings: all, echo: { propertyType, zipCodes: zips, filters }, tookMs: Date.now()-t0 });
  } catch (e) {
    console.warn('SCRAPER fatal error:', e?.message || String(e));
    scraperState = { ...scraperState, isRunning: false, status: 'idle' };
    return res.status(200).json({ listings: [], echo: req.body || {}, warning: 'error', tookMs: Date.now()-t0 });
  }
});

router.get('/status', async (_req, res) => {
  try { return res.json(scraperState); } catch (e) { return res.status(500).json({ error: 'Failed', message: String(e) }); }
});

router.get('/listings', async (_req, res) => {
  try { return res.json({ listings: [], total: 0 }); } catch (e) { return res.status(500).json({ error: 'Failed', message: String(e) }); }
});

router.post('/stop', async (_req, res) => {
  try { scraperState = { ...scraperState, isRunning: false, status: 'stopped' }; return res.json({ status: scraperState }); } catch (e) { return res.status(500).json({ error: 'Failed', message: String(e) }); }
});

export default router;
