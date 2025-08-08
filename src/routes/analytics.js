import express from 'express';

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    return res.json({ messagesPerDay: 0, responseRate: '0%', topZip: '-' });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load analytics', message: e?.message || String(e) });
  }
});

export default router;


