import express from 'express';
import { sendMessage } from '../contact/zillowMessage.js';

const router = express.Router();

// POST /api/message/send { url, message, testMode, skipNoAgents }
router.post('/send', async (req, res) => {
  try {
    const { url, message, testMode = true, skipNoAgents = true } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const out = await sendMessage({ url, message, testMode, skipNoAgents });
    return res.json({ ...out, timestamp: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to send message', message: e?.message || String(e) });
  }
});

// POST /api/message/regenerate { listing }
router.post('/regenerate', async (req, res) => {
  try {
    // TODO: implement real regeneration via AI
    return res.json({ message: 'Hi there! This is a regenerated preview message.' });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to regenerate', message: e?.message || String(e) });
  }
});

// POST /api/message/send-batch { propertyType, maxMessages }
router.post('/send-batch', async (req, res) => {
  try {
    const results = [];
    // TODO: implement real batch send; returning empty list is acceptable placeholder
    return res.json(results);
  } catch (e) {
    return res.status(500).json({ error: 'Batch failed', message: e?.message || String(e) });
  }
});

// POST /api/message/test
router.post('/test', async (_req, res) => {
  try {
    return res.json({ ok: true, simulated: true });
  } catch (e) {
    return res.status(500).json({ error: 'Test failed', message: e?.message || String(e) });
  }
});

// POST /api/message/preview { listing }
router.post('/preview', async (_req, res) => {
  try {
    return res.json({ message: 'This is a preview of the generated message.' });
  } catch (e) {
    return res.status(500).json({ error: 'Preview failed', message: e?.message || String(e) });
  }
});

export default router;


