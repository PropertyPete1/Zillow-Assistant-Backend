import express from 'express';

const router = express.Router();

let scraperState = {
  isRunning: false,
  lastRun: null,
  totalListings: 0,
  status: 'idle',
};

// Preferred endpoint used by frontend
router.post('/run', async (req, res) => {
  try {
    const { propertyType, zipCodes, filters } = req.body || {};
    scraperState = { ...scraperState, isRunning: true, status: 'running', lastRun: new Date().toISOString() };
    return res.json({ listings: [], status: scraperState, params: { propertyType, zipCodes, filters } });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to start scraper', message: e?.message || String(e) });
  }
});

router.get('/status', async (_req, res) => {
  try { return res.json(scraperState); } catch (e) { return res.status(500).json({ error: 'Failed', message: String(e) }); }
});

router.get('/listings', async (_req, res) => {
  try { return res.json({ listings: [], total: 0 }); } catch (e) { return res.status(500).json({ error: 'Failed', message: String(e) }); }
});

router.post('/stop', async (_req, res) => {
  try { scraperState = { ...scraperState, isRunning: false, status: 'stopped' }; return res.json({ status: scraperState }); } catch (e) { return res.status(500).json({ error: 'Failed', message: String(e) }); }
});

export default router;
