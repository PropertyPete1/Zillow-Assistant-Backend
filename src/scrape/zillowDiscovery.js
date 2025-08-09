import chromium from '@sparticuz/chromium';
import { randomInt } from 'crypto';

function buildCitySlug(city) {
  return String(city).trim().replace(/\s+/g, '-').replace(/,+/g, '');
}

export async function discoverListings({ city, mode = 'rent' }) {
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({
    executablePath: await chromium.executablePath(),
    headless: chromium.headless !== false,
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280 + randomInt(0, 120), height: 900 + randomInt(0, 120) },
  });
  const page = await browser.newPage();
  try {
    const slug = buildCitySlug(city || 'Austin, TX');
    const primary = `https://www.zillow.com/${slug}/rent-houses/`;
    const fallback = `https://www.zillow.com/${slug}/rentals/`;
    let target = primary;
    console.log(`DISCOVERY url=${target}`);
    const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    if (!resp || resp.status() >= 400) {
      target = fallback;
      console.log(`DISCOVERY url=${target}`);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    }
    // Dismiss overlays best effort
    try {
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
        const el = await page.$(sel);
        if (el) { await el.click({ delay: 30 }).catch(() => {}); await page.waitForTimeout(250); }
      }
    } catch {}

    await page.waitForTimeout(800);

    const extracted = await page.evaluate(() => {
      function safeParse(t){ try { return JSON.parse(t); } catch { return null; } }
      const next = document.querySelector('#__NEXT_DATA__');
      const out = { paths: 0, listings: [] };
      if (!next || !next.textContent) return out;
      const j = safeParse(next.textContent);
      if (!j) return out;
      const foundPaths = new Set();
      function walk(node, path, depth){
        if (!node || depth>7) return;
        if (Array.isArray(node)) {
          if (node.length && typeof node[0] === 'object') {
            const first = node[0];
            const hasZpid = 'zpid' in first;
            const hasDetail = Object.keys(first).some(k => /detailurl|hdpurl|url/i.test(k));
            if (hasZpid || hasDetail) {
              foundPaths.add(path);
              for (const it of node) {
                try {
                  const href = it.detailUrl || it.hdpUrl || it.url || (it.zpid ? `/homedetails/${it.zpid}_zpid/` : null);
                  if (!href) continue;
                  const abs = href.startsWith('http') ? href : (location.origin.replace(/\/+$/,'') + (href.startsWith('/')?href:'/'+href));
                  const addr = it.address || it?.hdpData?.homeInfo?.streetAddress || '';
                  const price = it.price || it.unformattedPrice || it?.hdpData?.homeInfo?.price || '';
                  const beds = it.beds || it?.hdpData?.homeInfo?.bedrooms || null;
                  const baths = it.baths || it?.hdpData?.homeInfo?.bathrooms || null;
                  const lat = it.latLong?.latitude ?? it?.hdpData?.homeInfo?.latitude ?? null;
                  const lng = it.latLong?.longitude ?? it?.hdpData?.homeInfo?.longitude ?? null;
                  const badgeOwner = !!(it.isFrbo || it.isFsbo || (Array.isArray(it.badges) && it.badges.join(' ').toLowerCase().includes('owner')) || (it.listingProviderType && String(it.listingProviderType).toLowerCase().includes('owner')));
                  out.listings.push({ zpid: it.zpid || null, url: abs.split('?')[0], address: addr, price, beds, baths, lat, lng, badgeOwner, ownerName: null });
                } catch {}
              }
            }
          }
          return;
        }
        if (typeof node === 'object') {
          let i=0; for (const k in node) { if (++i>120) break; walk(node[k], path?`${path}.${k}`:k, depth+1); }
        }
      }
      walk(j, '', 0);
      out.paths = Array.from(foundPaths).length;
      return out;
    });

    console.log(`DISCOVERY next_data.paths=${extracted.paths}`);
    const unique = Array.from(new Map(extracted.listings.map(x => [x.url, x])).values()).slice(0, 50);
    console.log(`DISCOVERY listings=${unique.length}`);
    return unique;
  } finally {
    try { await page.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}


