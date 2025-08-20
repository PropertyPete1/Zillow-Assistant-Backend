import { google } from 'googleapis';
import { Listing } from '../types';

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_EMAIL;
  const keyB64 = process.env.GOOGLE_SERVICE_KEY_BASE64;
  if (!email || !keyB64) return null;
  const key = Buffer.from(keyB64, 'base64').toString('utf8');
  return new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

export async function appendToSheets(rows: any[][]) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) return false;
  const auth = getAuth();
  if (!auth) return false;
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'OwnerOnly!A1',
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
  return true;
}

export function toSheetRows(listings: Listing[], status: 'KEPT' | 'DROPPED'): any[][] {
  const now = new Date().toISOString();
  return listings.map(l => [
    now,
    status,
    l.id,
    l.url,
    l.address ?? '',
    l.price ?? '',
    l.bedrooms ?? '',
    l.ownerName ?? '',
    l.ownerConfidence ?? '',
    l.isLikelyCompany ? 'YES' : 'NO',
    l.excludeReason ?? '',
    (l.sourceSignals as any)?.mgmtKeywords?.join('|') ?? (l.sourceSignals as any)?.hasMgmtKeywords?.join('|') ?? '',
    l.sourceSignals?.domMarkers?.join('|') ?? '',
  ]);
}


