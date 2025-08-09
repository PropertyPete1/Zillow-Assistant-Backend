import express from 'express';
import Settings from '../models/Settings.js';
import bcrypt from 'bcryptjs';

const router = express.Router();

const safe = (doc) => {
  if (!doc) return {};
  const obj = doc.toObject ? doc.toObject() : doc;
  return {
    propertyType: obj.propertyType,
    zipCodes: obj.zipCodes || [],
    minBedrooms: obj.minBedrooms || 0,
    maxPrice: obj.maxPrice || 0,
    redFlagDetection: !!obj.redFlagDetection,
    dailyMessageLimit: obj.dailyMessageLimit || 0,
    messageWindow: obj.messageWindow || ['10:00','18:00'],
    testMode: !!obj.testMode,
    googleSheetUrl: obj.googleSheetUrl || '',
    autoMessages: !!obj.autoMessages,
    zillowLogin: { email: obj?.zillowLogin?.email || '' },
  };
};

router.get('/', async (_req, res) => {
  try {
    const one = await Settings.findOne().lean();
    return res.json(safe(one || {}));
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load settings', message: e?.message || String(e) });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    // basic validations
    if (Array.isArray(body.messageWindow) && body.messageWindow.length === 2) {
      const [start, end] = body.messageWindow;
      if (start && end && end <= start) {
        return res.status(400).json({ error: 'Invalid messageWindow', message: 'End must be greater than start (HH:mm).' });
      }
    }
    if (body.googleSheetUrl && !String(body.googleSheetUrl).includes('/spreadsheets/')) {
      return res.status(400).json({ error: 'Invalid spreadsheetId in googleSheetUrl' });
    }
    const update = { ...body };
    if (body.zillowLogin?.password) {
      const hash = await bcrypt.hash(body.zillowLogin.password, 10);
      update.zillowLogin = { email: body.zillowLogin.email || '', passwordHash: hash };
    } else if (body.zillowLogin) {
      update.zillowLogin = { email: body.zillowLogin.email || '' };
    }
    const saved = await Settings.findOneAndUpdate({}, update, { new: true, upsert: true, setDefaultsOnInsert: true });
    return res.json(safe(saved));
  } catch (e) {
    return res.status(500).json({ error: 'Failed to save settings', message: e?.message || String(e) });
  }
});

export default router;


