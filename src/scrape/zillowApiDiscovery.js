import got from 'got';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

function encodeState(obj) { return encodeURIComponent(JSON.stringify(obj)); }
function decodeState(encoded) { try { return JSON.parse(decodeURIComponent(encoded)); } catch { return null; } }

function extractSearchQueryStateFromUrl(url) {
  try { const u = new URL(url); const p = u.searchParams.get('searchQueryState'); if (!p) return null; return decodeState(p); } catch { return null; }
}

function buildBaseStateForCity(city, mode) {
  const filterState = { sort: { value: 'priorityscore' } };
  if (mode === 'rent') {
    filterState['fr'] = { value: true };
    for (const k of ['fsba','fsbo','nc','cmsn','auc','fore','tow','mf','con','land','apa','manu','apco']) filterState[k] = { value: false };
  }
  return {
    pagination: { currentPage: 1 },
    isMapVisible: false,
    mapBounds: { west: -98.20, east: -97.40, south: 30.05, north: 30.55 },
    regionSelection: [{ regionId: 10221, regionType: 6 }],
    filterState,
    isListVisible: true,
  };
}

async function fetchPage(state) {
  const wants = encodeURIComponent(JSON.stringify({ cat1: ['listResults','mapResults'], cat2: ['total'] }));
  const url = `https://www.zillow.com/search/GetSearchPageState.htm?searchQueryState=${encodeState(state)}&wants=${wants}&requestId=1`;
  const res = await got(url, { headers: { 'user-agent': UA, 'accept': 'application/json,text/plain,*/*', 'referer': 'https://www.zillow.com/' }, timeout: { request: 20000 }, http2: true }).json();
  return res;
}

function flattenResults(json) {
  const out = [];
  const list = json?.cat1?.searchResults?.listResults;
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    try {
      const zpid = item?.zpid ?? item?.id;
      let url = item?.detailUrl || item?.hdpUrl || item?.url; if (url && url.startsWith('/')) url = `https://www.zillow.com${url}`;
      const address = item?.address || item?.hdpData?.homeInfo?.streetAddress || item?.addressStreet || item?.via?.address;
      const price = item?.unformattedPrice ?? item?.price ?? item?.hdpData?.homeInfo?.price;
      const beds = item?.beds ?? item?.hdpData?.homeInfo?.beds;
      const baths = item?.baths ?? item?.hdpData?.homeInfo?.baths;
      const lat = item?.latLong?.latitude ?? item?.hdpData?.homeInfo?.latitude;
      const lng = item?.latLong?.longitude ?? item?.hdpData?.homeInfo?.longitude;
      const isOwner = !!item?.isFsbo || !!item?.isFrbo || /owner/i.test(JSON.stringify(item?.badges || item?.brokerName || item?.variableData || ''));
      if (url) out.push({ zpid, url, address, price, beds, baths, lat, lng, badgeOwner: isOwner });
    } catch {}
  }
  return out;
}

export async function discoverListingsApi({ cityQuery, srpUrl, maxPages = 3 }, mode = 'rent') {
  let state = null;
  if (srpUrl) { const fromUrl = extractSearchQueryStateFromUrl(srpUrl); if (fromUrl) state = fromUrl; }
  if (!state) {
    if (!cityQuery) throw new Error('cityQuery or srpUrl with searchQueryState required');
    state = buildBaseStateForCity(cityQuery, mode);
  }
  const listings = [];
  let pageNum = state?.pagination?.currentPage || 1;
  for (let i=0; i<maxPages; i++) {
    state.pagination = { currentPage: pageNum };
    const json = await fetchPage(state);
    const pageListings = flattenResults(json);
    for (const L of pageListings) { if (!listings.find(x => x.url === L.url)) listings.push(L); }
    if (!pageListings.length) break;
    const totalPages = json?.cat1?.searchList?.totalPages ?? 0; // optional
    pageNum += 1;
  }
  return { listings: listings.slice(0, 60), echo: { cityQuery, mode, pagesTried: Math.min(maxPages, pageNum - (state?.pagination?.currentPage || 1) + 1) } };
}


