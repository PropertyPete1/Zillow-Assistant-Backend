import { Router, Request, Response } from 'express';
import { z } from 'zod';
import dayjs from 'dayjs';
import { ensureMongo, MessageLog } from '../db/models';
import { appendToSheets, messageSheetRows } from '../lib/googleSheets';

const router = Router();

const CheckQ = z.object({
  listingId: z.string(),
});
const LogQ = z.object({
  listingId: z.string(),
  listingUrl: z.string().url(),
  address: z.string().optional(),
  ownerName: z.string().optional(),
  messageText: z.string(),
  status: z.enum(['SENT','BLOCKED_DUP','FAILED','CONFIRMED_BUT_NOT_SENT']),
  reason: z.string().optional(),
  meta: z.record(z.any()).optional()
});

router.get('/check', async (req: Request, res: Response) => {
  const parsed = CheckQ.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!process.env.MONGODB_URI) {
    const days = Number(process.env.DUPLICATE_WINDOW_DAYS ?? 30);
    return res.json({ duplicate: false, windowDays: days });
  }
  await ensureMongo();
  const days = Number(process.env.DUPLICATE_WINDOW_DAYS ?? 30);
  const since = dayjs().subtract(days, 'day').toDate();

  const exists = await MessageLog.findOne({
    listingId: parsed.data.listingId,
    createdAt: { $gte: since },
    status: 'SENT'
  }).lean();

  res.json({ duplicate: !!exists, windowDays: days });
});

router.post('/log', async (req: Request, res: Response) => {
  const parsed = LogQ.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  let docId: any = undefined;
  if (process.env.MONGODB_URI) {
    await ensureMongo();
    const doc = await MessageLog.create({
      ...parsed.data,
      sentAt: parsed.data.status === 'SENT' ? new Date() : undefined,
    });
    docId = doc._id;
  }

  try {
    await appendToSheets(
      messageSheetRows([parsed.data]),
      'Messages!A1'
    );
  } catch {}

  res.json({ ok: true, id: docId });
});

export default router;


