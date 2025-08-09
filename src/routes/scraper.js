import express from 'express';
import Settings from '../models/Settings.js';
import { discoverListings } from '../scrape/zillowDiscovery.js';

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

// JSON helpers for homedetail URL extraction
function collectHomeDetailStrings(obj, out) {
  try {
    if (!obj) return;
    if (typeof obj === 'string') {
      if (obj.includes('/homedetails/')) out.add(obj);
      return;
    }
    if (Array.isArray(obj)) {
      for (const v of obj) collectHomeDetailStrings(v, out);
      return;
    }
    if (typeof obj === 'object') {
      for (const k in obj) {
        const v = obj[k];
        if (k === 'detailUrl' || k === 'canonicalUrl' || k === 'url' || k === 'href') {
          if (typeof v === 'string' && v.includes('/homedetails/')) out.add(v);
        }
        collectHomeDetailStrings(v, out);
      }
    }
  } catch {}
}

function extractHomeDetailUrlsFromJson(json, origin = 'https://www.zillow.com') {
  const found = new Set();
  collectHomeDetailStrings(json, found);
  const urls = [];
  for (const raw of found) {
    try {
      const href = raw.startsWith('http') ? raw : origin.replace(/\/+$/, '') + (raw.startsWith('/') ? raw : '/' + raw);
      if (href.includes('/homedetails/')) urls.push(href.split('?')[0]);
    } catch {}
  }
  return Array.from(new Set(urls)).slice(0, 100);
}

async function doScrolls(page, times = 6, range = [1000, 1800]) {
  function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
  for (let i = 0; i < times; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.evaluate((ms)=>new Promise(r=>setTimeout(r,ms)), rand(range[0], range[1]));
  }
}

// Dismiss cookie/consent/sign-in overlays on Zillow
async function zillowDismissOverlays(page) {
  const sels = [
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button[aria-label*="accept"]',
    '[data-test="privacy-accept"]',
    'button[aria-label*="close"]',
    '[data-test="close"]',
    '[data-testid="close"]',
  ];
  for (const sel of sels) {
    try {
      const el = await page.$(sel);
    if (el) { await el.click({ delay: 50 }); await page.evaluate(ms=>new Promise(r=>setTimeout(r,ms)), 400); }
    } catch {}
  }
}

// Robust Chromium launch with retries and health check
async function launchBrowser(puppeteer, chromium) {
  const opts = {
    executablePath: chromium ? await chromium.executablePath() : undefined,
    headless: chromium ? (chromium.headless !== false) : true,
    args: [
      ...((chromium && chromium.args) || []),
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-zygote',
      '--window-size=1366,768',
    ],
    ignoreHTTPSErrors: true,
    defaultViewport: (chromium && chromium.defaultViewport) || { width: 1366, height: 768 },
    protocolTimeout: 120000,
  };
  for (let i = 0; i < 2; i++) {
    try {
      const browser = await puppeteer.launch(opts);
      const page = await browser.newPage();
      await page.goto('about:blank');
      await page.close();
      return browser;
    } catch (e) {
      console.warn('LAUNCH error', e?.message || String(e));
      if (i === 1) throw e;
      await sleep(1500);
    }
  }
}

// DuckDuckGo HTML endpoint parsing (no JS)
function extractZillowLinksFromDDGHtml(html) {
  const links = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const href = m[1];
      const url = new URL(href, 'https://html.duckduckgo.com');
      if (!/zillow\.com/i.test(url.hostname)) continue;
      const u = url.href;
      if (u.includes('/y.js') || u.includes('/aclick')) continue;
      links.push(u);
    } catch {}
  }
  const uniq = Array.from(new Set(links));
  const homedetails = uniq.filter(u => /\/homedetails\//i.test(u));
  const homes = uniq.filter(u => /\/homes\//i.test(u));
  return homedetails.concat(homes).slice(0, 10);
}

async function ddgHtmlTry(page, query) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  console.log(`PHASE.DDG_HTML q="${query}"`);
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
  if (!resp) return [];
  const html = await page.content();
  const links = extractZillowLinksFromDDGHtml(html);
  console.log(`PHASE.DDG_HTML links=${links.length}`);
  return links;
}

async function ddgNormalTry(page, query) {
  console.log(`PHASE.DDG_NORMAL q="${query}"`);
  await page.goto('https://duckduckgo.com/?q=' + encodeURIComponent(query), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  try { await page.evaluate(ms=>new Promise(r=>setTimeout(r,ms)), 1000); } catch {}
  const selectors = ['#links a.result__a', 'a[data-testid="result-title-a"]'];
  const links = await page.evaluate((sels) => {
    const urls = new Set();
    for (const sel of sels) {
      document.querySelectorAll(sel).forEach(a => {
        const href = a && a.href || '';
        try {
          const u = new URL(href, location.origin).href;
          const host = new URL(u).hostname;
          if (/zillow\.com/i.test(host)) urls.add(u);
        } catch {}
      });
    }
    return Array.from(urls);
  }, selectors).catch(() => []);
  console.log(`PHASE.DDG_NORMAL links=${links.length}`);
  return links;
}

async function getZillowLandingUrl(page, queries, cityOrZip) {
  function chooseCanonical(urls){
    const rejectTokens = /(pet-friendly|newest|pricea|beds-|bath-|sqft-|days_sort|paymenta|lot-size)/i;
    for (const u of urls) {
      try {
        const p = new URL(u);
        const path = p.pathname || '';
        if (!/zillow\.com$/i.test(p.hostname) && !/\.zillow\.com$/i.test(p.hostname)) continue;
        if (rejectTokens.test(path)) continue;
        if (/^\/homes\/for_rent\//i.test(path) || /^\/rentals\//i.test(path) || /^\/rent-houses\//i.test(path)) return p.href;
      } catch {}
    }
    return null;
  }
  // Try HTML endpoint first
  for (let i = 0; i < queries.length; i++) {
    const list = await ddgHtmlTry(page, queries[i]);
    const chosen = chooseCanonical(list);
    if (chosen) { console.log(`SCRAPER ddg chosen="${chosen}"`); return chosen; }
  }
  // Then normal ddg.com
  for (let i = 0; i < queries.length; i++) {
    const list = await ddgNormalTry(page, queries[i]);
    const chosen = chooseCanonical(list);
    if (chosen) { console.log(`SCRAPER ddg chosen="${chosen}"`); return chosen; }
  }
  // One more normal retry with first query
  try {
    const list = await ddgNormalTry(page, queries[0]);
    const chosen = chooseCanonical(list);
    if (chosen) { console.log(`SCRAPER ddg chosen="${chosen}"`); return chosen; }
  } catch {}
  // Fallback direct Zillow city/zip browse
  const fallback = `https://www.zillow.com/homes/${encodeURIComponent(String(cityOrZip).replace(/\s+/g, '-'))}_rb/`;
  console.log(`SCRAPER ddg chosen="${fallback}"`);
  return fallback;
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

// NOTE: Legacy DOM grid harvest removed. JSON-first only.

async function runZip({ puppeteer, chromium }, { propertyType, zip, filters, cityQuery = false, buildCityQuery = null }) {
  const start = Date.now();
  // eslint-disable-next-line no-console
  console.log(`SCRAPER start propertyType=${propertyType} zip=${zip}`);
  const totalT = makeTimer();
  const extraFlags = ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--single-process','--no-zygote'];
  let browser;
  try {
    let launchOptions;
    browser = await launchBrowser(puppeteer, chromium);
    const page = await browser.newPage();
    try { page.setDefaultNavigationTimeout(60000); } catch {}
    try { page.setDefaultTimeout(60000); } catch {}
    await page.setUserAgent(`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Math.floor(120+Math.random()*5)}.0.0.0 Safari/537.36`);
    await page.setViewport({ width: 1200 + Math.floor(Math.random()*200), height: 900 + Math.floor(Math.random()*200) });

    const ddgT = makeTimer();
    const cityOrZip = String(zip).replace(/,/g, '');
    const queries = [];
    if (propertyType === 'rent') {
      queries.push(cityQuery && buildCityQuery ? buildCityQuery('rent', cityOrZip) : buildQuery('rent', cityOrZip));
      queries.push(`site:zillow.com ${cityOrZip} frbo`);
      queries.push(`site:zillow.com/homedetails ${cityOrZip} for rent by owner`);
    } else if (propertyType === 'sale') {
      queries.push(cityQuery && buildCityQuery ? buildCityQuery('sale', cityOrZip) : buildQuery('sale', cityOrZip));
      queries.push(`site:zillow.com ${cityOrZip} fsbo`);
      queries.push(`site:zillow.com/homedetails ${cityOrZip} for sale by owner`);
    } else {
      queries.push(cityQuery && buildCityQuery ? buildCityQuery('rent', cityOrZip) : buildQuery('rent', cityOrZip));
      queries.push(cityQuery && buildCityQuery ? buildCityQuery('sale', cityOrZip) : buildQuery('sale', cityOrZip));
      queries.push(`site:zillow.com/homedetails ${cityOrZip}`);
    }

    const landing = await getZillowLandingUrl(page, queries, cityOrZip);
    try { await page.goto(landing, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch {}
    try { await page.evaluate(ms=>new Promise(r=>setTimeout(r,ms)), 1500); } catch {}
    ddgT.mark('DDG done');
    console.log('SCRAPER zillow navigation complete');
    // Safety delay for client-side routing to settle
    try { await page.evaluate(ms=>new Promise(r=>setTimeout(r,ms)), 1500); } catch {}
    try { await zillowDismissOverlays(page); console.log('SCRAPER overlays dismissed'); } catch {}
    // No grid clicks; avoid DOM-based flows
    try { const loc = await page.evaluate(() => ({ host: location.host, path: location.pathname })); console.log(`SCRAPER zillow host=${loc.host} path=${loc.path}`); } catch {}
    totalT.mark('Zillow landing');
    const cardsSel = 'a[data-test="property-card-link"], a.property-card-link, ul.photo-cards li article a[href*="/homedetails/"]';
    // Scroll 5–6x with waits to trigger lazy load
    const scrollTimes = 6;
    for (let i = 0; i < scrollTimes; i++) { await page.evaluate(() => { window.scrollBy(0, window.innerHeight); }); await sleep(1200 + Math.floor(Math.random()*600)); }
    // Dump compact __NEXT_DATA__ summary for path discovery
    let znextRoots = [];
    let znextPaths = [];
    let znextSamples = [];
    try {
      const zsum = await page.evaluate(() => {
        function safeParse(txt){ try{return JSON.parse(txt)}catch(_){return null} }
        function gp(obj, path){ return path.split('.').reduce((o,k)=>o?.[k], obj); }
        const out = { roots: [], listKeys: [], samples: [] };
        const next = document.querySelector('#__NEXT_DATA__');
        if (!next || !next.textContent) return out;
        const j = safeParse(next.textContent);
        if (!j) return out;
        const roots = [
          'props',
          'props.pageProps',
          'props.pageProps.searchPageState',
          'props.pageProps.initialReduxState',
          'props.pageProps.componentProps',
        ];
        out.roots = roots.filter(p=>{ const segs=p.split('.'); let cur=j; for(const s of segs){ cur=cur?.[s]; if(!cur) return false } return true });
        function walk(node,path,depth){ if(depth>6||!node) return; if(Array.isArray(node)){ if(node.length && typeof node[0]==='object'){ const first=node[0]; const hasDetail=Object.keys(first).some(k=>/detailurl|hdpurl|url/i.test(k)); const hasZpid=('zpid' in first); if(hasDetail||hasZpid){ out.listKeys.push(path); out.samples.push({ path, sample:{ zpid:first?.zpid??null, detailUrl:Object.entries(first).find(([k])=>/detailurl|hdpurl|url/i.test(k))?.[1]??null, address:first?.address??first?.hdpData?.homeInfo?.streetAddress??null, price:first?.price??first?.unformattedPrice??first?.hdpData?.homeInfo?.price??null, keys:Object.keys(first).slice(0,20) }}) } } } else if(typeof node==='object'){ let i=0; for(const k in node){ i++; if(i>100) break; walk(node[k], path?`${path}.${k}`:k, depth+1) } } }
        walk(j,'',0); out.listKeys = Array.from(new Set(out.listKeys)).slice(0,25); out.samples = out.samples.slice(0,5); return out;
      });
      znextRoots = zsum?.roots || [];
      znextPaths = zsum?.listKeys || [];
      znextSamples = zsum?.samples || [];
      console.log('ZILLOW_NEXT_DATA_SUMMARY roots=', znextRoots);
      console.log('ZILLOW_NEXT_DATA_LIST_PATHS', znextPaths);
      try { console.log('ZILLOW_NEXT_DATA_SAMPLES', JSON.stringify(znextSamples)); } catch {}
    } catch {}
    // Replace JSON-first with network sniffer + perf fallback
    const netStart = Date.now();
    const netLinks = new Set();
    const wanted = /GetSearchPageState|\/api\/search|search-page-sub-app|SearchPageSubApp|search\/GetSearchPageState/i;
    const onResp = async (res) => {
      try {
        const u = res.url();
        if (!/zillow\.com/i.test(u) || !wanted.test(u)) return;
        const ct = (res.headers()['content-type']||'').toLowerCase();
        if (!ct.includes('json')) return;
        const text = await res.text(); if (!text) return;
        let data; try { data = JSON.parse(text); } catch { return; }
        function gp(o,p){ try { return p.split('.').reduce((x,k)=>x?.[k], o); } catch { return null; } }
        const paths = [
          'cat1.searchResults.listResults',
          'cat1.searchResults.mapResults',
          'searchResults.listResults',
          'searchResults.mapResults',
          'results',
          'homes',
        ];
        for (const p of paths) {
          const arr = gp(data, p);
          if (Array.isArray(arr) && arr.length) {
            for (const it of arr) {
              try {
                let href = it?.detailUrl || it?.hdpUrl || it?.url || (it?.zpid ? `/homedetails/${it.zpid}_zpid/` : null);
                if (!href) continue;
                if (!href.startsWith('http')) href = 'https://www.zillow.com' + (href.startsWith('/')?href:'/'+href);
                if (href.includes('/homedetails/')) netLinks.add(href.split('?')[0]);
              } catch {}
            }
            break; // first non-empty
          }
        }
      } catch {}
    };
    try { page.on('response', onResp); } catch {}
    while (Date.now() - netStart < 15000) {
      if (netLinks.size > 0) break;
      await sleep(500);
    }
    try { page.off('response', onResp); } catch {}
    let links = Array.from(netLinks).slice(0,50);
    console.log('PHASE.NET links=', links.length);
    if (!links.length) {
      try {
        const perfLinks = await page.evaluate(() => {
          const out = new Set();
          try {
            const entries = performance.getEntriesByType('resource') || [];
            entries.forEach(e => { try { const n = e.name || ''; if (n.includes('/homedetails/')) out.add(n.split('?')[0]); } catch {} });
          } catch {}
          return Array.from(out).slice(0,50);
        });
        links = perfLinks;
      } catch {}
      console.log('FALLBACK.PERF links=', Array.isArray(links)?links.length:0);
    }
    if (!links.length) {
      const meta = { timings: { ddg_ms: ddgT.elapsed(), json_ms: 0, dom_ms: 0, detail_ms: 0, total_ms: totalT.elapsed() }, jsonCount: 0, domCount: 0, candidateCount: 0 };
      return { listings: [], warning: 'selectors-empty', durationMs: Date.now()-start, meta };
    }

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
          const bodyRaw = (document.body?.innerText || '');
          const bodyText = bodyRaw.toLowerCase();
          const isOwner = bodyText.includes('listed by property owner') || bodyText.includes('for rent by owner');
          const rented = /off market|rented|leased/i.test(bodyRaw);
          // Owner name via regex best-effort
          let ownerName = '';
          try {
            const m = bodyRaw.match(/listed by property owner\s*[:\-]?\s*([a-zA-Z][a-zA-Z .'-]{2,60})/i);
            if (m && m[1]) ownerName = m[1].trim();
          } catch {}
          const provider = document.querySelector('[data-test="listing-provider"], [data-testid*="owner"], [data-testid="listing-provider"], [data-test="provider-label"]');
          if (!ownerName) ownerName = (provider?.innerText || '').trim();
          const phoneMatch = bodyRaw.match(/\b\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/);
          const addrEl = document.querySelector('[data-test="bdp-address"], [data-test="home-details-summary"] address, h1');
          const priceEl = document.querySelector('[data-test="price"], [data-testid="price"], [data-test="property-card-price"]');
          const addr = addrEl ? (addrEl.textContent || '').trim() : '';
          const price = priceEl ? (priceEl.textContent || '').trim() : '';
          return { isOwner, rented, ownerName, phone: phoneMatch ? phoneMatch[0] : '', address: addr, price };
        });
        // Apply filters: skipNoAgents and skipAlreadyRented
        if ((filters && filters.skipNoAgents) && !detail.isOwner) {
          console.log(`DETAIL owner=false name="" url=${href}`);
          continue;
        }
        if ((filters && filters.skipAlreadyRented) && detail.rented) continue;
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
          ownerName: (detail.ownerName || '').trim(),
          phone: detail.phone || '',
          link: href,
          type: type,
          bedrooms: null,
          labelMatch: 'PROPERTY_OWNER',
        };
        const nm = (item.ownerName || '').replace(/\s+/g,' ').trim();
        console.log(`DETAIL owner=${!!detail.isOwner} name="${nm}" url=${href}`);
        console.log(`SCRAPER ✅ OWNER: label=PROPERTY_OWNER | name=${nm || 'Unknown'} | phone=${item.phone || 'N/A'} | addr=${item.address || 'No address'} | price=${item.price || 'No price'}`);
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
      znext: { roots: znextRoots, paths: znextPaths, samples: znextSamples },
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
    // Discovery via direct Zillow SRP (__NEXT_DATA__) JSON-first
    if (cityQuery && String(cityQuery).trim()) {
      const city = String(cityQuery).trim();
      const listings = await discoverListings({ city, mode });
      scraperState = { ...scraperState, isRunning: false, status: 'idle', totalListings: listings.length };
      return res.json({ listings, echo: { propertyType: mode, zipCodes: [], cityQuery: city, filters }, warning: listings.length ? null : 'selectors-empty', tookMs: Date.now()-t0 });
    }
    const zips = Array.isArray(zipCodes) && zipCodes.length ? zipCodes.slice(0, 2) : ['78704'];
    const all = [];
    const warnings = [];
    for (const zip of zips) {
      const city = String(zip).trim();
      const list = await discoverListings({ city, mode });
      all.push(...list);
      await sleep(400 + Math.random()*500);
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
