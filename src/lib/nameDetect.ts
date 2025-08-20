const COMPANY_KEYWORDS = [
  'property management','management','mgmt','realty','realtors','realtor','real estate',
  'apartments','apartment','leasing','lease','rentals','homes llc','llc','llp','inc','corp',
  'company','broker','brokerage','team','group','holdings','partners','associates','pm',
  'residential','commercial','leasing office','office','community','complex','apartments llc'
];

const DOM_MARKERS = [
  'listed by','brokered by','agent','leasing office','apartment community',
  'property manager','managed by','office hours','tour','apply now'
];

const APT_COMPLEX_SIGNALS = ['apply now','availability','floor plans','amenities'];

function likelyCompany(text: string): {isCompany: boolean; hits: string[]} {
  const hay = text.toLowerCase();
  const hits = COMPANY_KEYWORDS.filter(k => hay.includes(k));
  return { isCompany: hits.length > 0, hits };
}

function cleanTokens(s: string) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/[|,;:\/#()]/g, ' ')
    .trim();
}

function isHumanNameCandidate(s: string): boolean {
  const t = cleanTokens(s).split(' ').filter(Boolean);
  if (t.length < 2 || t.length > 3) return false;
  if (!t.every(tok => /^[A-Za-z'-]+$/.test(tok))) return false;
  if (!t.every(tok => tok[0] === tok[0].toUpperCase())) return false;
  const { isCompany } = likelyCompany(s);
  return !isCompany;
}

export function extractHumanNames(texts: string[]): string[] {
  const pool = new Set<string>();
  texts.forEach(t => {
    if (!t) return;
    // Pull capitalized phrases as a simple, dependency-light approach
    const capitals = (t.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g) ?? []);
    capitals.forEach(p => { if (isHumanNameCandidate(p)) pool.add(cleanTokens(p)); });
  });
  return Array.from(pool);
}

export function pickBestName(cands: string[], page: string): {name?: string; confidence: number} {
  if (!cands.length) return { confidence: 0 };
  const lower = page.toLowerCase();
  let best = cands[0]; let bestScore = 0.5;
  for (const c of cands) {
    let score = 0.5;
    if (lower.includes('owner')) score += 0.2;
    const around = lower.indexOf(c.toLowerCase());
    if (around >= 0) {
      const window = lower.slice(Math.max(0, around - 40), around + c.length + 40);
      if (window.includes('owner')) score += 0.2;
      if (window.includes('listed by') || window.includes('agent')) score -= 0.2;
    }
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return { name: best, confidence: Math.min(1, Math.max(0, bestScore)) };
}

export function classifyTextForCompany(texts: string[]): {isCompany: boolean; mgmtHits: string[]; domMarkers: string[]; aptHits: string[]} {
  const joined = texts.filter(Boolean).join(' · ').toLowerCase();
  const mgmtHits = COMPANY_KEYWORDS.filter(k => joined.includes(k));
  const domMarkers = DOM_MARKERS.filter(k => joined.includes(k));
  const aptHits = APT_COMPLEX_SIGNALS.filter(k => joined.includes(k));
  return { isCompany: mgmtHits.length > 0, mgmtHits, domMarkers, aptHits };
}


