import { launchBrowser } from './chrome.js';

function buildCitySlug(city) {
  return String(city).trim().replace(/\s+/g, '-').replace(/,+/g, '');
}

// Network-response capture implementation
export async function discoverListings({ city, mode = 'rent' }) {
  const slug = buildCitySlug(city || 'Austin, TX');
  const srps = mode === 'rent'
    ? [`https://www.zillow.com/${slug}/rent-houses/`, `https://www.zillow.com/${slug}/rentals/`]
    : [`https://www.zillow.com/${slug}/homes/`];

  const browser = await launchBrowser();
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
        if (!/GetSearchPageState|searchPageState|searchResults|listResults|search-page/i.test(u)) return;
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
      await page.evaluate(ms=>new Promise(r=>setTimeout(r,ms)), 1200);
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.evaluate(ms=>new Promise(r=>setTimeout(r,ms)), 900);
      const start = Date.now();
      while (Date.now() - start < 5000 && captured.length === 0) {
        await page.evaluate(ms=>new Promise(r=>setTimeout(r,ms)), 250);
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
      for (const p of paths) {
        const v = gp(c.json, p);
        if (Array.isArray(v)) {
          for (const it of v) {
            try {
              const href = it.detailUrl ?? it.hdpUrl ?? it.url ?? '';
              const abs = href.startsWith('http') ? href : `https://www.zillow.com${href}`;
              if (!abs) continue;
              const info = it.hdpData?.homeInfo ?? {};
              const price = it.unformattedPrice ?? info?.price ?? it.price ?? null;
              const beds = it.beds ?? info.bedrooms ?? null;
              const baths = it.baths ?? info.bathrooms ?? null;
              const lat = info?.latLong?.latitude ?? it.latLong?.latitude ?? null;
              const lng = info?.latLong?.longitude ?? it.latLong?.longitude ?? null;
              const badgeOwner = !!it.isFrbo || !!it.isFsbo || (Array.isArray(it.badges) && it.badges.some(b=>/owner|frbo|fsbo/i.test(JSON.stringify(b)))) || /owner|frbo|fsbo/i.test(String(it.listingProviderType||''));
              listings.push({ zpid: it.zpid ?? info.zpid ?? null, url: abs.split('?')[0], address: it.address ?? info.streetAddress ?? null, price, beds, baths, lat, lng, badgeOwner, ownerName: null });
            } catch {}
          }
        } else if (p === 'categorySearchResults' && Array.isArray(v)) {
          for (const cat of v) {
            if (Array.isArray(cat?.listResults)) {
              for (const it of cat.listResults) {
                try {
                  const href = it.detailUrl ?? it.hdpUrl ?? it.url ?? '';
                  const abs = href.startsWith('http') ? href : `https://www.zillow.com${href}`;
                  if (!abs) continue;
                  const info = it.hdpData?.homeInfo ?? {};
                  const price = it.unformattedPrice ?? info?.price ?? it.price ?? null;
                  const beds = it.beds ?? info.bedrooms ?? null;
                  const baths = it.baths ?? info.bathrooms ?? null;
                  const lat = info?.latLong?.latitude ?? it.latLong?.latitude ?? null;
                  const lng = info?.latLong?.longitude ?? it.latLong?.longitude ?? null;
                  const badgeOwner = !!it.isFrbo || !!it.isFsbo || (Array.isArray(it.badges) && it.badges.some(b=>/owner|frbo|fsbo/i.test(JSON.stringify(b)))) || /owner|frbo|fsbo/i.test(String(it.listingProviderType||''));
                  listings.push({ zpid: it.zpid ?? info.zpid ?? null, url: abs.split('?')[0], address: it.address ?? info.streetAddress ?? null, price, beds, baths, lat, lng, badgeOwner, ownerName: null });
                } catch {}
              }
            }
          }
        }
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


