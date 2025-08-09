import express from 'express';
import { google } from 'googleapis';
import Settings from '../models/Settings.js';
import Secrets from '../models/Secrets.js';

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    return res.json([]);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load logs', message: e?.message || String(e) });
  }
});

router.post('/export-to-sheets', async (_req, res) => {
  try {
    const settings = await Settings.findOne().lean();
    const sheetUrl = settings?.googleSheetUrl || '';
    const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) return res.status(400).json({ error: 'Invalid spreadsheetId in settings.googleSheetUrl' });
    const spreadsheetId = match[1];

    // Load service account creds
    let svcEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
    let svcKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
    const sec = await Secrets.findOne().lean();
    if (sec?.googleServiceAccountEmail) svcEmail = sec.googleServiceAccountEmail;
    if (sec?.googleServiceAccountKey) svcKey = sec.googleServiceAccountKey;
    if (!svcEmail || !svcKey) return res.status(500).json({ error: 'Google service account credentials invalid/missing. Check server secrets.' });

    // Normalize key
    let credentials;
    try {
      credentials = typeof svcKey === 'string' && svcKey.trim().startsWith('{') ? JSON.parse(svcKey) : { client_email: svcEmail, private_key: svcKey };
      if (!credentials.client_email) credentials.client_email = svcEmail;
    } catch {
      credentials = { client_email: svcEmail, private_key: svcKey };
    }

    const auth = new google.auth.JWT(credentials.client_email, undefined, credentials.private_key, ['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth });

    // Minimal sample rows; replace with real logs when available
    const rows = [
      ['Address','Owner','Price','Bedrooms','Type','Status','Timestamp','RedFlags'],
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });

    return res.json({ ok: true, appended: rows.length });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/The caller does not have permission/i.test(msg)) return res.status(403).json({ error: 'The service account is not shared on this spreadsheet. Share as Editor.' });
    if (/Requested entity was not found/i.test(msg)) return res.status(404).json({ error: 'Spreadsheet or tab not found.' });
    return res.status(500).json({ error: 'Internal error contacting Google Sheets (reason redacted).' });
  }
});

export default router;


