import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';

const router = express.Router();

function makeHash(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function getLeadsCollection() {
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1 || !conn.db) return null;
  return conn.db.collection('leads');
}

const cooldownDays = Number(process.env.LEADS_COOLDOWN_DAYS || 90);

router.get('/next-batch', async (req, res) => {
  try {
    const col = getLeadsCollection();
    if (!col) return res.status(503).json({ error: 'db_unavailable' });

    const count = Math.min(Number(req.query.count || 10), 25);
    const city = (req.query.city || '').toString().toLowerCase().trim();
    const priceMax = Number(req.query.priceMax || 0);

    const now = Date.now();
    const sinceIso = new Date(now - cooldownDays * 24 * 60 * 60 * 1000).toISOString();

    const q = { status: 'queued', $or: [ { last_action_at: { $exists: false } }, { last_action_at: { $lt: sinceIso } } ] };
    if (city) q.cityLower = city;
    if (priceMax) q.priceNum = { $lte: priceMax };

    const docs = await col.find(q).limit(count).toArray();
    const out = docs.map(d => ({
      url: d.url,
      address: d.address,
      city: d.city,
      price: d.price,
      beds: d.beds,
      baths: d.baths,
      source: d.source,
      notes: d.notes,
    }));
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: 'failed', message: e?.message || String(e) });
  }
});

router.post('/mark', async (req, res) => {
  try {
    const col = getLeadsCollection();
    if (!col) return res.status(503).json({ error: 'db_unavailable' });

    const { url, status, reason, address, price, notes } = req.body || {};
    if (!url || !status) return res.status(400).json({ error: 'url and status required' });

    const hash = makeHash(String(url));
    const nowIso = new Date().toISOString();

    await col.updateOne(
      { hash },
      {
        $set: {
          url,
          status,
          notes: notes || reason || '',
          address: address || undefined,
          price: price || undefined,
          last_action_at: nowIso,
        },
        $setOnInsert: { created_at: nowIso },
      },
      { upsert: true }
    );
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'failed', message: e?.message || String(e) });
  }
});

router.post('/ingest', async (req, res) => {
  try {
    const col = getLeadsCollection();
    if (!col) return res.status(503).json({ error: 'db_unavailable' });

    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: 'rows array required' });

    const ops = rows.map(r => {
      const hash = r.hash || makeHash(String(r.url || '') + String(r.address || ''));
      const priceNum = Number(String(r.price || '').replace(/[^\d]/g, '') || 0);
      const cityLower = String(r.city || '').toLowerCase();
      return {
        updateOne: {
          filter: { hash },
          update: {
            $setOnInsert: { created_at: new Date().toISOString() },
            $set: { ...r, hash, priceNum, cityLower },
          },
          upsert: true,
        },
      };
    });
    if (ops.length) await col.bulkWrite(ops, { ordered: false });
    return res.json({ ok: true, added: ops.length });
  } catch (e) {
    return res.status(500).json({ error: 'failed', message: e?.message || String(e) });
  }
});

export default router;


