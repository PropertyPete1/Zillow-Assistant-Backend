import express from 'express';

const router = express.Router();

let SETTINGS = {
  propertyType: 'both',
  zipCodes: [],
  minBedrooms: 0,
  maxPrice: 0,
  redFlagDetection: true,
  dailyMessageLimit: 5,
  messageWindow: ['10:00', '18:00'],
  testMode: false,
  googleSheetUrl: '',
};

router.get('/', async (_req, res) => {
  return res.json(SETTINGS);
});

router.post('/', async (req, res) => {
  SETTINGS = { ...SETTINGS, ...(req.body || {}) };
  return res.json(SETTINGS);
});

export default router;


