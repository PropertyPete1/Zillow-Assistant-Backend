import chromium from '@sparticuz/chromium';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import puppeteerExtra from 'puppeteer-extra';
import { wait } from '../utils/wait.js';

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

export async function sendMessage({ url, message, testMode = true, skipNoAgents = true }) {
  puppeteerExtra.use(StealthPlugin());
  const browser = await puppeteerExtra.launch({
    executablePath: await chromium.executablePath(),
    headless: chromium.headless !== false,
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();
  try {
    try { await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'); } catch {}
    const z = new URL(url);
    const zpidMatch = z.pathname.match(/(\d+)_zpid/);
    const zpid = zpidMatch ? zpidMatch[1] : '';
    const q = zpid ? `site:zillow.com ${zpid} _zpid` : `site:zillow.com/homedetails ${z.pathname.split('/').slice(-2,-1)[0]}`;
    await page.goto('https://duckduckgo.com/?q=' + encodeURIComponent(q), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
    await wait(700);
    // Click first matching Zillow result hosting the same zpid/path
    const candidate = await page.evaluate((wantPath) => {
      const as = Array.from(document.querySelectorAll('a[href*="zillow.com"]'));
      const cand = as.find(a => {
        try { const u = new URL(a.href); return u.pathname.includes(wantPath); } catch { return false; }
      });
      return cand ? cand.href : null;
    }, zpid ? `${zpid}_zpid` : z.pathname.replace(/\/$/, ''));
    const target = candidate || url;
    await page.goto(target, { waitUntil: 'networkidle2', timeout: 45000 }).catch(()=>{});
    await wait(1000 + Math.floor(Math.random()*400));
    // Dismiss overlays
    try {
      const sels = [
        'button:has-text("Accept")','button:has-text("I agree")','button[aria-label*="accept"]','[data-test="privacy-accept"]','button[aria-label*="close"]','[data-test="close"]','[data-testid="close"]'
      ];
      for (const sel of sels) { const el = await page.$(sel); if (el) { await el.click({ delay: 20 }).catch(()=>{}); await wait(200); } }
    } catch {}
    const bodyRaw = await page.evaluate(() => document.body?.innerText || '');
    const body = bodyRaw.toLowerCase();
    const isOwner = body.includes('listed by property owner') || body.includes('for rent by owner');
    let ownerName = '';
    try {
      const m = bodyRaw.match(/listed by property owner\s*[:\-]?\s*([a-zA-Z][a-zA-Z .'-]{2,60})/i);
      if (m && m[1]) ownerName = m[1].trim();
    } catch {}
    if (skipNoAgents && !isOwner) {
      console.log('CONTACT skip: agent');
      return { skipped: 'agent', owner: false };
    }
    console.log(`CONTACT ownerName="${ownerName}" found=${Boolean(ownerName)}`);
    if (testMode) return { ok: true, preview: true, owner: isOwner, ownerName };
    // Attempt to fill but do not violate captcha
    const hasCaptcha = await page.evaluate(() => !!document.querySelector('iframe[src*="recaptcha"], .h-captcha, div[id*="captcha"], iframe[title*="challenge"]'));
    if (hasCaptcha) return { blocked: true, owner: isOwner, ownerName };
    // Best-effort form fill (selectors vary)
    const selMessage = 'textarea, [name*="message" i], [aria-label*="message" i]';
    try { const el = await page.$(selMessage); if (el) { await el.click(); await page.type(selMessage, String(message||'Hello!'), { delay: 20 }); } } catch {}
    // Best-effort submit
    const selSubmit = 'button[type=submit], button:has-text("Send"), [role=button]:has-text("Send")';
    try { const btn = await page.$(selSubmit); if (btn) { await btn.click({ delay: 20 }); await page.waitForTimeout(1200); } } catch {}
    return { ok: true, owner: isOwner, ownerName };
  } finally {
    try { await page.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}


