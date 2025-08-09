import express from 'express';
import Settings from '../models/Settings.js';

const router = express.Router();

let scraperState = {
  isRunning: false,
  lastRun: null,
  totalListings: 0,
  status: 'idle',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPuppeteer() {
  try {
    // Try serverless-friendly core first
    const { default: puppeteerCore } = await import('puppeteer-core');
    const chromium = (await import('@sparticuz/chromium')).default;
    return { puppeteer: puppeteerCore, chromium };
  } catch {
    // Fallback to bundled puppeteer
    const { default: puppeteer } = await import('puppeteer');
    return { puppeteer, chromium: null };
  }
}

function buildQuery(propertyType, zip) {
  const mode = propertyType === 'rent' ? 'for rent by owner' : propertyType === 'sale' ? 'for sale by owner' : 'for rent by owner';
  return `site:zillow.com ${zip} ${mode}`;
}

function buildCityQuery(propertyType, cityQuery) {
  const mode = propertyType === 'rent' ? 'for rent by owner' : propertyType === 'sale' ? 'for sale by owner' : 'for rent by owner';
  return `site:zillow.com "${cityQuery}" ${mode}`;
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
        const addrEl = card && (card.querySelector('[data-test="property-card-addr"], [data-test="property-card-address"], address, h2, h3'));
        const address = addrEl ? (addrEl.textContent || '').trim() : ((a.textContent || '').trim());
        const priceEl = card && (card.querySelector('[data-test="property-card-price"], .PropertyCardWrapper__StyledPrice, [class*="price"]'));
        const priceText = priceEl ? (priceEl.textContent || '').trim() : '';
        const bedsEl = card && (card.querySelector('[data-test*="bed-bath"], [class*="bed"]'));
        const bedsText = bedsEl ? (bedsEl.textContent || '').trim() : '';
        const bedrooms = parseInt((bedsText.match(/\d+/)||['0'])[0],10)||0;
        results.push({ address, price: priceText, bedrooms, ownerName: '', link });
      } catch {}
    }
    return results;
  });
  return items;
}

async function runZip({ puppeteer, chromium }, { propertyType, zip, filters, cityQuery = false, buildCityQuery = null }) {
  const start = Date.now();
  // eslint-disable-next-line no-console
  console.log(`SCRAPER start propertyType=${propertyType} zip=${zip}`);
  const extraFlags = ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--single-process','--no-zygote'];
  let browser;
  try {
    let launchOptions;
    if (chromium) {
      const execPath = await chromium.executablePath();
      launchOptions = {
        args: [...(chromium.args || []), ...extraFlags],
        defaultViewport: chromium.defaultViewport,
        executablePath: execPath,
        headless: chromium.headless,
      };
    } else {
      launchOptions = { headless: true, args: extraFlags };
    }
    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    try { page.setDefaultNavigationTimeout(60000); } catch {}
    try { page.setDefaultTimeout(60000); } catch {}
    await page.setUserAgent(`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Math.floor(120+Math.random()*5)}.0.0.0 Safari/537.36`);
    await page.setViewport({ width: 1200 + Math.floor(Math.random()*200), height: 900 + Math.floor(Math.random()*200) });

    const query = cityQuery && buildCityQuery ? buildCityQuery(propertyType, zip) : buildQuery(propertyType, zip);
    console.log(`SCRAPER ddg query="${query}"`);
    await page.goto('https://duckduckgo.com/', { timeout: 25000, waitUntil: 'networkidle2' });
    await sleep(300 + Math.random()*700);
    await page.type('input[name="q"]', query, { delay: 50 + Math.random()*40 });
    await Promise.all([
      page.keyboard.press('Enter'),
      page.waitForNavigation({ timeout: 25000, waitUntil: 'networkidle2' })
    ]);
    await sleep(300 + Math.random()*700);
    const linkHandle = await page.$('a.result__a[href*="zillow.com"]') || await page.$('a[href*="zillow.com/"]');
    if (!linkHandle) {
      console.warn('SCRAPER warning: no zillow result');
      return { listings: [], warning: 'selectors-empty', durationMs: Date.now()-start };
    }
    await Promise.all([
      linkHandle.click({ delay: 50 + Math.random()*50 }),
      page.waitForNavigation({ timeout: 30000, waitUntil: 'networkidle2' })
    ]);
    console.log('SCRAPER zillow click ok');
    const cardsSel = 'a[data-test="property-card-link"], a.property-card-link, ul.photo-cards li article a[href*="/homedetails/"]';
    try {
      await page.waitForSelector(cardsSel, { timeout: 20000 });
      console.log('SCRAPER page ready');
    } catch {
      console.warn('SCRAPER warn selectors-empty (no cards yet)');
    }
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => { window.scrollBy(0, window.innerHeight); });
      await sleep(1500);
    }
    try { const count = await page.$$eval(cardsSel, els => els.length); console.log(`SCRAPER cards found=${count}`); } catch {}
    let rows = await extractListings(page);
    try { console.log(`SCRAPER cards found(after extract)=${rows.length}`); } catch {}
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
    const warning = rows.length ? null : 'selectors-empty';
    return { listings: rows, warning, durationMs: Date.now()-start };
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
    let { propertyType, zipCodes = [], filters = {}, cityQuery } = req.body || {};
    let mode = (typeof propertyType === 'string' && ['rent','sale','both'].includes(propertyType)) ? propertyType : undefined;
    let modeReason = 'request';
    if (!mode) {
      try {
        const s = await Settings.findOne().sort({ updatedAt: -1 }).lean();
        if (s?.propertyType) { mode = s.propertyType; modeReason = 'settings'; }
      } catch {}
    }
    if (!mode) { mode = 'rent'; modeReason = 'default'; }
    if (!Array.isArray(zipCodes) || !zipCodes.length) {
      try {
        const s = await Settings.findOne().sort({ updatedAt: -1 }).lean();
        if (s?.zipCodes?.length) zipCodes = s.zipCodes;
      } catch {}
    }
    if (!cityQuery && (!Array.isArray(zipCodes) || !zipCodes.length)) {
      console.warn('SCRAPER warn no-zipcodes');
      return res.status(200).json({ listings: [], echo: { propertyType, zipCodes: [], filters }, warning: 'no-zipcodes', tookMs: Date.now()-t0 });
    }
    scraperState = { ...scraperState, isRunning: true, status: 'running', lastRun: new Date().toISOString() };
    console.log('SCRAPER start', { useMode: mode, reason: modeReason, zipCodes, cityQuery, filters });
    const { puppeteer, chromium } = await getPuppeteer();
    if (chromium) { try { const p = await chromium.executablePath(); console.log('SCRAPER chromiumPath=', p); } catch {}
      try { const ua = (chromium.userAgent || '').slice(0, 40); if (ua) console.log('SCRAPER ua=', ua); } catch {} }
    // Single city mode
    if (cityQuery && String(cityQuery).trim()) {
      const city = String(cityQuery).trim();
      if (mode === 'both') {
        const r1 = await runZip({ puppeteer, chromium }, { propertyType: 'rent', zip: city, filters, cityQuery: true, buildCityQuery });
        const r2 = await runZip({ puppeteer, chromium }, { propertyType: 'sale', zip: city, filters, cityQuery: true, buildCityQuery });
        const all = [...(r1.listings||[]), ...(r2.listings||[])];
        scraperState = { ...scraperState, isRunning: false, status: 'idle', totalListings: all.length };
        const warning = all.length ? null : (r1.warning || r2.warning || 'selectors-empty');
        return res.json({ listings: all, echo: { propertyType: mode, zipCodes: [], cityQuery: city, filters }, warning, tookMs: Date.now()-t0 });
      } else {
        const { listings, warning } = await runZip({ puppeteer, chromium }, { propertyType: mode, zip: city, filters, cityQuery: true, buildCityQuery });
        scraperState = { ...scraperState, isRunning: false, status: 'idle', totalListings: listings.length };
        return res.json({ listings, echo: { propertyType: mode, zipCodes: [], cityQuery: city, filters }, warning: listings.length ? null : (warning || 'selectors-empty'), tookMs: Date.now()-t0 });
      }
    }
    const zips = Array.isArray(zipCodes) && zipCodes.length ? zipCodes.slice(0, 2) : ['78704'];
    const all = [];
    const warnings = [];
    for (const zip of zips) {
      const { listings, warning } = await runZip({ puppeteer, chromium }, { propertyType: mode, zip, filters });
      if (warning) warnings.push(warning);
      all.push(...(listings || []));
      await sleep(500 + Math.random()*700);
    }
    scraperState = { ...scraperState, isRunning: false, status: 'idle', totalListings: all.length };
    const warning = all.length ? null : (warnings[0] || null);
    return res.json({ listings: all, echo: { propertyType: mode, zipCodes: zips, cityQuery: '', filters }, warning, tookMs: Date.now()-t0 });
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
