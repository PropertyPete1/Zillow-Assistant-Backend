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
    await page.waitForTimeout(rand(range[0], range[1]));
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
      if (el) { await el.click({ delay: 50 }); await page.waitForTimeout(400); }
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
  try { await page.waitForTimeout(1000); } catch {}
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
  // Try HTML endpoint first
  for (let i = 0; i < queries.length; i++) {
    const list = await ddgHtmlTry(page, queries[i]);
    if (list.length) {
      console.log(`SCRAPER ddg html click="${list[0]}"`);
      return list[0];
    }
  }
  // Then normal ddg.com
  for (let i = 0; i < queries.length; i++) {
    const list = await ddgNormalTry(page, queries[i]);
    if (list.length) {
      console.log(`SCRAPER ddg normal click="${list[0]}"`);
      return list[0];
    }
  }
  // One more normal retry with first query
  try {
    const list = await ddgNormalTry(page, queries[0]);
    console.log('PHASE.DDG_NORMAL retry links=', list.length);
    if (list.length) return list[0];
  } catch {}
  // Fallback direct Zillow city/zip browse
  const fallback = `https://www.zillow.com/homes/${encodeURIComponent(String(cityOrZip).replace(/\s+/g, '-'))}_rb/`;
  console.log(`SCRAPER ddg fallback="${fallback}"`);
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
    try { await page.waitForTimeout(1500); } catch {}
    ddgT.mark('DDG done');
    console.log('SCRAPER zillow navigation complete');
    // Safety delay for client-side routing to settle
    try { await page.waitForTimeout(1500); } catch {}
    try { await zillowDismissOverlays(page); console.log('SCRAPER overlays dismissed'); } catch {}
    // Force List view if present
    try {
      const clicked = await page.evaluate(() => {
        const bs = Array.from(document.querySelectorAll('button'));
        const b = bs.find(x => (x.innerText||'').trim().toLowerCase()==='list');
        if (b) { b.click(); return true; }
        const byData = document.querySelector('[data-test="list-button"]');
        if (byData) { (byData).click(); return true; }
        return false;
      });
      if (clicked) { await page.waitForTimeout(1200); }
    } catch {}
    console.log('SCRAPER zillow click ok');
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
        const out = { roots: [], listKeys: [], samples: [] };
        const next = document.querySelector('#__NEXT_DATA__');
        if (!next || !next.textContent) return out;
        const j = safeParse(next.textContent);
        if (!j) return out;
        const roots = [
          'props','pageProps','query','buildId','assetPrefix',
          'props.pageProps','props.pageProps.searchPageState','props.pageProps.initialReduxState',
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
    // JSON-first harvest (collect URLs)
    const jMark = makeTimer();
    let jsonLinks = [];
    // Try path-based links first from common paths
    try {
      const pathLinks = await page.evaluate(() => {
        function safeParse(txt){ try{return JSON.parse(txt)}catch(_){return null} }
        function get(obj,path){ const segs=path.split('.'); let cur=obj; for(const s of segs){ cur=cur?.[s]; if(!cur) return null } return cur }
        const next = document.querySelector('#__NEXT_DATA__'); if(!next||!next.textContent) return [];
        const j = safeParse(next.textContent); if(!j) return [];
        const candidates = [
          'props.pageProps.searchPageState.cat1.searchResults.listResults',
          'props.pageProps.initialReduxState.searchPageState.cat1.searchResults.listResults',
          'props.pageProps.searchPageState.cat1.searchResults.mapResults',
        ];
        const links = new Set();
        for (const p of candidates) {
          const arr = get(j, p);
          if (Array.isArray(arr)) {
            for (const it of arr.slice(0,200)) {
              if (it && typeof it==='object') {
                const href = it.detailUrl || it.hdpUrl || it.url;
                if (href && typeof href==='string') {
                  const abs = href.startsWith('http') ? href : (location.origin.replace(/\/+$/,'') + (href.startsWith('/')?href:'/'+href));
                  if (abs.includes('/homedetails/')) links.add(abs.split('?')[0]);
                }
              }
            }
          }
        }
        return Array.from(links).slice(0,100);
      });
      if (Array.isArray(pathLinks) && pathLinks.length) { jsonLinks = pathLinks; }
    } catch {}
    try {
      jsonLinks = await page.evaluate(() => {
        function safeParse(txt){ try{ return JSON.parse(txt); }catch{return null;} }
        function collectHomeDetailStrings(obj, out){
          try{
            if (!obj) return;
            if (typeof obj === 'string'){ if (obj.includes('/homedetails/')) out.add(obj); return; }
            if (Array.isArray(obj)){ for (const v of obj) collectHomeDetailStrings(v, out); return; }
            if (typeof obj === 'object'){
              for (const k in obj){
                const v = obj[k];
                if ((k === 'detailUrl' || k === 'canonicalUrl' || k === 'url' || k === 'href') && typeof v === 'string' && v.includes('/homedetails/')) out.add(v);
                collectHomeDetailStrings(v, out);
              }
            }
          }catch(e){}
        }
        const found = new Set();
        const nextEl = document.querySelector('#__NEXT_DATA__');
        if (nextEl && nextEl.textContent) {
          const j = safeParse(nextEl.textContent.trim());
          if (j) collectHomeDetailStrings(j, found);
        }
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        for (const s of scripts) {
          if (!s.textContent) continue;
          const j = safeParse(s.textContent.trim());
          if (j) collectHomeDetailStrings(j, found);
        }
        const origin = location.origin.replace(/\/+$/,'');
        const urls = Array.from(found).map(u => (u.startsWith('http') ? u : origin + (u.startsWith('/')?u:'/'+u)).split('?')[0]).filter(u => u.includes('/homedetails/'));
        return Array.from(new Set(urls)).slice(0, 100);
      });
    } catch (e) { console.warn('PHASE.JSON error', e?.message || String(e)); }
    const jsonCount = Array.isArray(jsonLinks) ? jsonLinks.length : 0;
    console.log('PHASE.JSON links=', jsonCount);
    jMark.mark('JSON harvest done');

    let links = [];
    let jsonLiveLinks = [];
    if (jsonCount) {
      links = jsonLinks.map(u => u.startsWith('http') ? u : `https://www.zillow.com${u}`);
    } else {
      // Live JSON capture (~10s) for GetSearchPageState/searchResults
      const netLinks = new Set();
      const onResp = async (res) => {
        try {
          const url = res.url();
          if (!/zillow\.com/i.test(url)) return;
          if (!/GetSearchPageState|search|graphql|listResults|searchResults/i.test(url)) return;
          const ct = (res.headers()['content-type']||'').toLowerCase();
          if (!ct.includes('json')) return;
          const text = await res.text(); if (!text) return;
          let data; try { data = JSON.parse(text); } catch { return; }
          (function walk(o){
            try { if (!o) return; if (typeof o === 'string') { if (o.includes('/homedetails/')) netLinks.add((o.startsWith('http')?o:'https://www.zillow.com'+(o.startsWith('/')?o:'/'+o)).split('?')[0]); return; } if (Array.isArray(o)) { for (const v of o) walk(v); return; } if (typeof o === 'object') { for (const k in o) walk(o[k]); } } catch {} }
          )(data);
        } catch {}
      };
      try { page.on('response', onResp); } catch {}
      try {
        await page.evaluate(async () => {
          const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
          const candidates = ['[data-test="search-list-content"]','div[role="list"]','ul.photo-cards','div[aria-label*="List"]'];
          let scroller = null; for (const sel of candidates) { const el = document.querySelector(sel); if (el) { scroller = el; break; } }
          if (!scroller) scroller = document.scrollingElement || document.body;
          for (let i=0;i<10;i++){ scroller.scrollBy(0, scroller.clientHeight); await sleep(900 + Math.floor(Math.random()*700)); }
        });
        await page.waitForTimeout(2000);
      } catch {}
      try { page.off('response', onResp); } catch {}
      jsonLiveLinks = Array.from(netLinks).slice(0, 100);
      console.log('PHASE.JSON_LIVE links=', jsonLiveLinks.length);
      if (jsonLiveLinks.length) {
        links = jsonLiveLinks;
      }
    }
    if (Array.isArray(links)) links = links.slice(0, 50);
    // If still 0, last resort DDG homedetails-only (skip DOM grid entirely)
    let ddgHomedetailsLinks = [];
    if (!links.length) {
      try {
        const onlyQ = `site:zillow.com/homedetails ${cityOrZip} for rent by owner`;
        const list = await ddgHtmlTry(page, onlyQ);
        ddgHomedetailsLinks = list.filter(u=>/\/homedetails\//i.test(u)).slice(0,10);
        console.log('PHASE.DDG_HTML homedetails_only links=', ddgHomedetailsLinks.length);
        links = ddgHomedetailsLinks;
      } catch {}
    }
    if (!links.length) {
      const meta = { timings: { ddg_ms: ddgT.elapsed(), json_ms: jMark.elapsed(), dom_ms: 0, detail_ms: 0, total_ms: totalT.elapsed() }, jsonCount, domCount: 0, candidateCount: 0, znext: { roots: znextRoots, paths: znextPaths, samples: znextSamples } };
      return { listings: [], warning: jsonCount? 'no-candidates' : 'no-next-data', durationMs: Date.now()-start, meta };
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
        const nm = (item.ownerName || 'Unknown').replace(/\s+/g,' ').trim();
        console.log(`DETAIL ${href} owner=true name="${nm}"`);
        console.log(`SCRAPER ✅ OWNER: label=PROPERTY_OWNER | name=${nm} | phone=${item.phone || 'N/A'} | addr=${item.address || 'No address'} | price=${item.price || 'No price'}`);
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
