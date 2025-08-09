import { launchBrowser } from './chrome.js';

// --- Helpers ported from TS spec ---
function cityToSlug(city) {
  return String(city || '')
    .trim()
    .replace(/\s*,\s*/g, '-')
    .replace(/\s+/g, '-');
}

function isZillowSRPJsonUrl(u) {
  return /GetSearchPageState|searchresults|search-page|SearchPageState/i.test(u);
}

async function dismissOverlays(page) {
  const sels = [
    '#onetrust-accept-btn-handler',
    '[data-testid="close"], [aria-label="Close"], button[aria-label="Close"]',
    '[data-testid="modal-close"]',
  ];
  for (const sel of sels) {
    try {
      const el = await page.$(sel);
      if (el) await el.click().catch(() => {});
    } catch {}
  }
}

function extractFromCat(cat) {
  const out = [];
  const arr = (cat?.searchResults?.listResults) || (cat?.searchResults?.results) || [];
  for (const it of arr) {
    try {
      const zpid = it?.zpid ?? it?.id ?? it?.hdpData?.homeInfo?.zpid;
      let url = it?.detailUrl || it?.hdpUrl || it?.hdpData?.homeInfo?.hdpUrl || it?.url || '';
      if (url && url.startsWith('/')) url = 'https://www.zillow.com' + url;
      if (!url || !/zillow\.com\/.*(homedetails|_zpid)/i.test(url)) continue;
      const address = it?.address || it?.addressStreet || it?.hdpData?.homeInfo?.streetAddress || it?.statusText || undefined;
      const price = it?.price || it?.unformattedPrice || it?.hdpData?.homeInfo?.price || it?.units?.[0]?.price || undefined;
      const beds = it?.beds ?? it?.hdpData?.homeInfo?.bedrooms ?? it?.units?.[0]?.beds ?? undefined;
      const baths = it?.baths ?? it?.hdpData?.homeInfo?.bathrooms ?? it?.units?.[0]?.baths ?? undefined;
      const lat = it?.latLong?.latitude ?? it?.hdpData?.homeInfo?.latitude;
      const lng = it?.latLong?.longitude ?? it?.hdpData?.homeInfo?.longitude;
      const badgeOwner = !!it?.isFsbo || !!it?.isFrbo ||
        (Array.isArray(it?.badges) && it.badges.some(b => /owner|frbo|fsbo/i.test(String(b?.text ?? b)))) ||
        /for rent by owner/i.test(String(it?.variableData?.type ?? '')) || false;
      out.push({ zpid, url, address, price, beds, baths, lat, lng, badgeOwner });
    } catch {}
  }
  return out;
}

function buildCitySlug(city) {
  return String(city).trim().replace(/\s+/g, '-').replace(/,+/g, '');
}

// Network-response capture implementation
export async function discoverListings({ city, mode = 'rent' }) {
  const slug = cityToSlug(city || 'Austin, TX');
  const srps = mode === 'rent'
    ? [`https://www.zillow.com/${slug}/rent-houses/`, `https://www.zillow.com/${slug}/rentals/`, `https://www.zillow.com/${slug}/`]
    : [`https://www.zillow.com/${slug}/homes/`];

  // Robust launch with lock and ETXTBSY workaround
  const { default: fs } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  let launchLock = Promise.resolve();
  async function withLaunchLock(fn){ let release; const prev=launchLock; launchLock=new Promise(res=>release=res); await prev; try{ return await fn(); } finally{ release(); } }
  async function prepareExecutable(execPath){ const tmp=`/tmp/chromium-${Date.now()}-${Math.floor(Math.random()*1e6)}`; await fs.copyFile(execPath, tmp); await fs.chmod(tmp, 0o755); return tmp; }

  const { launchBrowser: baseLaunch } = await import('./chrome.js');
  const { default: chromium } = await import('@sparticuz/chromium');
  const { default: puppeteer } = await import('puppeteer-core');
  const execPath0 = await chromium.executablePath();
  const browser = await withLaunchLock(async () => {
    let lastErr;
    for (let t=1; t<=3; t++) {
      try {
        const execPath = await prepareExecutable(execPath0);
        return await puppeteer.launch({
          headless: true,
          executablePath: execPath,
          args: [...chromium.args, '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
          defaultViewport: { width: 1360, height: 900 },
        });
      } catch (e) { lastErr = e; await new Promise(r=>setTimeout(r, 1200*t)); }
    }
    throw lastErr;
  });
  const page = await browser.newPage();
  try {
    try { await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'); } catch {}
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const rt = req.resourceType();
      if (rt === 'image' || rt === 'media' || rt === 'font' || rt === 'stylesheet') req.abort();
      else req.continue();
    });

    const captured = [];
    page.on('response', async (res) => {
      try {
        const u = res.url();
        const rt = res.request().resourceType();
        if (rt !== 'xhr' && rt !== 'fetch') return;
        if (!isZillowSRPJsonUrl(u)) return;
        const txt = await res.text(); if (!txt) return;
        let json = null; try { json = JSON.parse(txt); } catch {}
        if (!json && txt.includes('{')) {
          const a = txt.indexOf('{'); const b = txt.lastIndexOf('}');
          if (a >= 0 && b > a) { try { json = JSON.parse(txt.slice(a, b+1)); } catch {} }
        }
        if (json) captured.push({ url: u, json });
      } catch {}
    });

    let landed = '';
    for (const srp of srps) {
      console.log(`DISCOVERY url=${srp}`);
      await page.goto(srp, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
      await dismissOverlays(page);
      // nudge SRP: scrolls + optional map/list toggle + micro map drag
      for (let i=0;i<6;i++){ await page.evaluate(()=>window.scrollBy(0,1200)); await page.evaluate(ms=>new Promise(r=>setTimeout(r,ms)), 600 + Math.floor(Math.random()*400)); }
      try {
        const listBtn = await page.$('button:has-text("List")'); if (listBtn) { await listBtn.click().catch(()=>{}); await page.evaluate(ms=>new Promise(r=>setTimeout(r,ms)), 900); }
        const mapBtn = await page.$('button:has-text("Map")'); if (mapBtn) { await mapBtn.click().catch(()=>{}); await page.evaluate(ms=>new Promise(r=>setTimeout(r,ms)), 900); }
      } catch {}
      await page.evaluate(() => {
        const map = document.querySelector('[data-testid*="map"] canvas, [class*="map"] canvas');
        if (!map) return;
        const rect = map.getBoundingClientRect();
        const cx = rect.left + rect.width * 0.6;
        const cy = rect.top + rect.height * 0.6;
        const el = document.elementFromPoint(cx, cy);
        if (!el) return;
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, clientX: cx, clientY: cy }));
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles:true, clientX: cx-40, clientY: cy-30 }));
        el.dispatchEvent(new MouseEvent('mouseup',   { bubbles:true, clientX: cx-40, clientY: cy-30 }));
      });
      await page.evaluate(ms=>new Promise(r=>setTimeout(r,ms)), 900);
      const start = Date.now();
      while (Date.now() - start < 8000 && captured.length === 0) {
        await page.evaluate(ms=>new Promise(r=>setTimeout(r,ms)), 300);
      }
      const loc = await page.evaluate(() => ({ host: location.host, path: location.pathname }));
      console.log(`SCRAPER zillow host=${loc.host} path=${loc.path}`);
      if (captured.length) { landed = srp; break; }
    }

    const listings = [];
    function gp(o,p){ return p.split('.').reduce((a,k)=>a?.[k], o); }
    const paths = [
      'searchPageState.cat1.searchResults.listResults',
      'searchResults.listResults',
      'cat1.searchResults.listResults',
      'categorySearchResults',
    ];
    for (const c of captured) {
      const json = c.json;
      const cats = [
        json?.cat1,
        json?.cat2,
        json?.cat3,
        json?.props?.pageProps?.searchPageState?.cat1,
        json?.searchPageState?.cat1,
        json?.searchResults ? { searchResults: json.searchResults } : null,
      ].filter(Boolean);
      for (const cat of cats) {
        const got = extractFromCat(cat);
        for (const g of got) listings.push(g);
      }
    }

    const unique = Array.from(new Map(listings.map(x => [x.url, x])).values()).slice(0,50);
    console.log(`DISCOVERY next_data.paths=${captured.length}`);
    console.log(`DISCOVERY listings=${unique.length}`);
    return unique;
  } finally {
    try { await page.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}


