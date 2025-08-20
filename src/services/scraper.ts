import puppeteer from 'puppeteer';
import { Listing, ScrapeFilters, ScrapeResult } from '../types';
import { extractHumanNames, pickBestName, classifyTextForCompany } from '../lib/nameDetect';

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export async function scrapeZillow(filters: ScrapeFilters): Promise<ScrapeResult> {
  const ownersOnly = filters.ownersOnly !== false; // default true
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox','--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });

  const city = encodeURIComponent(filters.cityQuery ?? '');
  const baseUrl = `https://www.zillow.com/${city}/rent-houses/`;
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await delay(1500);

  const links: string[] = await page.$$eval('a[href*="/homedetails/"]', as => Array.from(new Set(as.map(a => (a as HTMLAnchorElement).href))));

  const included: Listing[] = [];
  const excluded: Listing[] = [];

  for (const url of links.slice(0, 60)) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await delay(800 + Math.floor(Math.random() * 600));

      const html = await page.content();
      const address = await page.$eval('h1', el => (el as HTMLElement).innerText).catch(() => undefined);
      const desc = await page.$eval('[data-testid="home-description-text"]', el => (el as HTMLElement).innerText).catch(() => undefined);
      const listedBy = await page.$$eval('*', nodes => nodes.map(n => (n as HTMLElement).innerText).filter(Boolean).find(t => /listed by|brokered by|agent/i.test(t ?? ''))).catch(() => undefined);

      const rawTextPool = [address ?? '', desc ?? '', listedBy ?? ''];
      const names = extractHumanNames(rawTextPool);
      const pick = pickBestName(names, html);
      const cls = classifyTextForCompany(rawTextPool);
      const isCompanyish = cls.isCompany || cls.aptHits.length > 0 || cls.domMarkers.includes('agent');

      const listing: Listing = {
        id: url.split('/').filter(Boolean).pop() || url,
        url,
        address,
        price: undefined,
        bedrooms: undefined,
        description: desc,
        listedByRaw: listedBy,
        extractedNames: names,
        ownerName: pick.name,
        ownerConfidence: pick.confidence,
        isLikelyCompany: isCompanyish,
        excludeReason: undefined,
        sourceSignals: {
          hasAgentBadge: cls.domMarkers.includes('agent'),
          hasMgmtKeywords: cls.mgmtHits,
          hasAptComplexSignals: cls.aptHits,
          domMarkers: cls.domMarkers,
        },
        ts: new Date().toISOString(),
      };

      if (ownersOnly) {
        if (!listing.ownerName || (listing.ownerConfidence ?? 0) < 0.55) {
          listing.excludeReason = 'no_confident_owner_name';
          excluded.push(listing);
          continue;
        }
        if (listing.isLikelyCompany) {
          listing.excludeReason = 'company_or_agent_detected';
          excluded.push(listing);
          continue;
        }
      }

      included.push(listing);
    } catch {
      // non-fatal; skip this url
    }
  }

  await browser.close();

  const reasons: Record<string, number> = {};
  for (const x of excluded) reasons[x.excludeReason ?? 'unknown'] = (reasons[x.excludeReason ?? 'unknown'] ?? 0) + 1;

  const res: ScrapeResult = {
    included,
    excluded,
    summary: { total: included.length + excluded.length, kept: included.length, dropped: excluded.length, reasons }
  };

  return res;
}


