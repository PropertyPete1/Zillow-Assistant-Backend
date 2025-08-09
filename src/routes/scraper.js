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

function makeTimer() {
  const s = Date.now();
  return {
    mark: (label) => { try { console.log(`⏱ ${label} ${Date.now() - s}ms`); } catch {} },
    elapsed: () => Date.now() - s,
  };
}

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

async function extractListings(page, { filters, mode }) {
  const items = await page.evaluate((args) => {
    const { filters, mode } = args || {};
    const CARD_SEL = 'a[data-test="property-card-link"], a.property-card-link, ul.photo-cards li article a[href*="/homedetails/"]';
    const anchors = Array.from(document.querySelectorAll(CARD_SEL));
    const results = [];
    const seen = new Set();
    for (const a of anchors) {
      try {
        const link = a.href;
        if (!link || seen.has(link)) continue; seen.add(link);
        const container = a.closest('article, li, div[data-test="property-card"], div');
        const text = (container?.innerText || '').toLowerCase();
        let labelMatch = null;
        if (text.includes('property owner')) labelMatch = 'PROPERTY_OWNER';
        else if (text.includes('for rent by owner')) labelMatch = 'FRBO';
        else if (text.includes('for sale by owner')) labelMatch = 'FSBO';

        if (filters && filters.skipNoAgents) {
          if (!labelMatch) continue;
        }

        const addrEl = container && (container.querySelector('[data-test="property-card-addr"], [data-test="property-card-address"], address, h2, h3'));
        const address = addrEl ? (addrEl.textContent || '').trim() : ((a.textContent || '').trim());
        const priceEl = container && (container.querySelector('[data-test="property-card-price"], .property-card-data span, .PropertyCardWrapper__StyledPrice, [class*="price"]'));
        const price = priceEl ? (priceEl.textContent || '').trim() : '';
        const bedsEl = container && (container.querySelector('[data-test*="bed-bath"], [class*="bed"]'));
        const bedsText = bedsEl ? (bedsEl.textContent || '').trim() : '';
        const bedrooms = parseInt((bedsText.match(/\d+/)||['0'])[0],10)||0;
        const ownerEl = container && (container.querySelector('[data-test="listing-provider"], [data-testid="listing-provider"], [data-test="agent-name"], strong, b, span'));
        const ownerName = ownerEl ? (ownerEl.textContent || '').trim() : '';

        let type = mode;
        if (mode === 'both') {
          if (labelMatch === 'FRBO') type = 'rent';
          else if (labelMatch === 'FSBO') type = 'sale';
        }

        results.push({ address, price, bedrooms, ownerName, link, type, labelMatch });
      } catch {}
    }
    return results;
  }, { filters, mode });
  return items;
}

async function runZip({ puppeteer, chromium }, { propertyType, zip, filters, cityQuery = false, buildCityQuery = null }) {
  const start = Date.now();
  // eslint-disable-next-line no-console
  console.log(`SCRAPER start propertyType=${propertyType} zip=${zip}`);
  const totalT = makeTimer();
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
    const ddgT = makeTimer();
    console.log(`PHASE.DDG try=1 q="${query}"`);
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
      console.warn('WARN ddg-no-zillow-result');
      totalT.mark('TOTAL done');
      return { listings: [], warning: 'ddg-no-zillow-result', durationMs: Date.now()-start, meta: { timings: { ddg_ms: ddgT.elapsed(), json_ms: 0, dom_ms: 0, detail_ms: 0, total_ms: totalT.elapsed() }, jsonCount: 0, domCount: 0, candidateCount: 0 } };
    }
    const ddgClickPromise = linkHandle.click({ delay: 50 + Math.random()*50 });
    await Promise.all([
      page.waitForNavigation({ timeout: 30000, waitUntil: 'networkidle2' }),
      ddgClickPromise,
    ]);
    ddgT.mark('DDG done');
    console.log('SCRAPER zillow navigation complete');
    // Safety delay for client-side routing to settle
    try { await page.waitForTimeout(1500); } catch {}
    console.log('SCRAPER zillow click ok');
    try { const loc = await page.evaluate(() => ({ host: location.host, path: location.pathname })); console.log(`SCRAPER zillow host=${loc.host} path=${loc.path}`); } catch {}
    totalT.mark('Zillow landing');
    const cardsSel = 'a[data-test="property-card-link"], a.property-card-link, ul.photo-cards li article a[href*="/homedetails/"]';
    // Scroll 5–6x with waits to trigger lazy load
    const scrollTimes = 6;
    for (let i = 0; i < scrollTimes; i++) { await page.evaluate(() => { window.scrollBy(0, window.innerHeight); }); await sleep(1200 + Math.floor(Math.random()*600)); }
    // JSON-first harvest (collect URLs)
    const jMark = makeTimer();
    let jsonLinks = [];
    try {
      jsonLinks = await page.evaluate(() => {
        const out = new Set();
        const add = (u) => { try { if (typeof u === 'string' && u.includes('/homedetails/')) out.add(u); } catch {} };
        const walk = (o) => { if (!o) return; if (typeof o === 'string') add(o); else if (Array.isArray(o)) o.forEach(walk); else if (typeof o === 'object') Object.values(o).forEach(walk); };
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"], #__NEXT_DATA__'));
        for (const s of scripts) { try { const txt = s.textContent || ''; const j = JSON.parse(txt); walk(j); } catch {} }
        return Array.from(out);
      });
    } catch (e) { console.warn('PHASE.JSON error', e?.message || String(e)); }
    const jsonCount = Array.isArray(jsonLinks) ? jsonLinks.length : 0;
    console.log('PHASE.JSON links=', jsonCount);
    jMark.mark('JSON harvest done');

    let links = [];
    if (jsonCount) {
      links = jsonLinks.map(u => u.startsWith('http') ? u : `https://www.zillow.com${u}`);
    } else {
      // DOM harvest for candidates (fallback)
      const dMark = makeTimer();
      try { await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, { timeout: 20000 }, cardsSel); } catch {}
      let preCount = 0;
      try { preCount = await page.$$eval(cardsSel, els => els.length); } catch {}
      console.log(`SCRAPER cards found(pre)=${preCount}`);
      try {
        links = await page.$$eval(
          'a[data-test="property-card-link"], a.property-card-link, [data-test="search-list-content"] a[href*="/homedetails/"], ul.photo-cards li article a[href*="/homedetails/"], a[href*="/homedetails/"][tabindex]',
          els => Array.from(new Set(els.map(a => (a instanceof HTMLAnchorElement ? a.href : a.getAttribute('href'))).filter(Boolean)))
        );
      } catch {}
      // Very last fallback
      try {
        const more = await page.$$eval('a[href*="/homedetails/"]', els => Array.from(new Set(els.map(a => (a instanceof HTMLAnchorElement ? a.href : a.getAttribute('href'))).filter(Boolean))));
        links = Array.from(new Set([...(links||[]), ...(more||[])]));
      } catch {}
      console.log('PHASE.DOM links=', Array.isArray(links)?links.length:0);
      dMark.mark('DOM harvest done');
    }
    if (Array.isArray(links)) links = links.slice(0, 50);

    const results = [];
    // Verify owner on detail page sequentially
    const detMark = makeTimer();
    for (const href of links) {
      try {
        console.log(`DETAIL nav -> ${href}`);
        try { await page.goto(href, { waitUntil: 'networkidle2', timeout: 30000 }); } catch (e) {
          if ((e?.message||'').includes('Execution context was destroyed')) {
            console.warn('Retrying after context destroyed');
            try { await page.goto(href, { waitUntil: 'networkidle2', timeout: 30000 }); } catch { continue; }
          } else { console.warn('DETAIL nav error', e?.message || String(e)); continue; }
        }
        await sleep(300 + Math.random()*500);
        const ownerCheckT = makeTimer();
        const detail = await page.evaluate(() => {
          const bodyText = (document.body?.innerText || '').toLowerCase();
          const ownerBadge = /listed by property owner/i.test(document.body?.innerText || '');
          // Try to pull name/phone near provider sections
          const provider = document.querySelector('[data-test="listing-provider"], [data-testid="listing-provider"], [data-test="provider-label"]');
          const providerText = (provider?.innerText || '').trim();
          const phoneMatch = (document.body?.innerText || '').match(/\b\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/);
          const addrEl = document.querySelector('[data-test="bdp-address"], [data-test="home-details-summary"] address, h1');
          const priceEl = document.querySelector('[data-test="price"], [data-testid="price"], [data-test="property-card-price"]');
          const addr = addrEl ? (addrEl.textContent || '').trim() : '';
          const price = priceEl ? (priceEl.textContent || '').trim() : '';
          return { ownerBadge, providerText, phone: phoneMatch ? phoneMatch[0] : '', address: addr, price };
        });
        console.log(`DETAIL ownerCheck ${detail.ownerBadge ? 'YES' : 'NO'}`);
        ownerCheckT.mark('done');
        if (!detail.ownerBadge) continue;
        // Determine type when both
        let type = propertyType;
        if (propertyType === 'both') {
          const t = await page.evaluate(() => {
            const txt = (document.body?.innerText || '').toLowerCase();
            if (/for rent/.test(txt)) return 'rent';
            if (/for sale/.test(txt)) return 'sale';
            return '';
          });
          if (t) type = t;
        }

        const item = {
          address: detail.address || '',
          price: detail.price || '',
          ownerName: detail.providerText || '',
          phone: detail.phone || '',
          link: href,
          type: type,
          labelMatch: 'PROPERTY_OWNER',
        };
        console.log(`SCRAPER ✅ OWNER: label=PROPERTY_OWNER | name=${item.ownerName || 'Unknown'} | phone=${item.phone || 'N/A'} | addr=${item.address || 'No address'} | price=${item.price || 'No price'}`);
        results.push(item);
      } catch (e) {
        // continue to next link
      }
    }

    // Apply filters & dedupe
    const { minBedrooms, maxPrice, skipDuplicatePhotos } = filters || {};
    let filtered = results.filter(r => {
      if (maxPrice) {
        const p = parseInt(String(r.price).replace(/[^0-9]/g, ''), 10) || 0;
        if (p && p > Number(maxPrice)) return false;
      }
      return true;
    });
    const seenKeys = new Set();
    const deduped = [];
    for (const r of filtered) {
      const key = `${(r.link||'').toLowerCase().trim()}|${(r.address||'').toLowerCase().trim()}|${(r.price||'').replace(/\s+/g,'').toLowerCase()}`;
      if (skipDuplicatePhotos) {
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
      }
      deduped.push(r);
    }

    console.log(`SCRAPER extracted=${deduped.length}`);
    detMark.mark('DETAIL loop done');
    totalT.mark('TOTAL done');
    const meta = {
      timings: {
        ddg_ms: 0,
        json_ms: 0,
        dom_ms: 0,
        detail_ms: detMark.elapsed(),
        total_ms: totalT.elapsed(),
      },
      jsonCount: jsonCount,
      domCount: jsonCount ? 0 : (Array.isArray(links)?links.length:0),
      candidateCount: Array.isArray(links)?links.length:0,
    };
    // Patch in measured ddg/json times if available
    try { meta.timings.ddg_ms = ddgT.elapsed(); } catch {}
    try { meta.timings.json_ms = jMark.elapsed(); } catch {}
    const warning = deduped.length ? null : 'owner-cards-empty';
    return { listings: deduped, warning, durationMs: Date.now()-start, meta };
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
