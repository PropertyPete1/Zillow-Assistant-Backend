import express from 'express';

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
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Export failed', message: e?.message || String(e) });
  }
});

export default router;


