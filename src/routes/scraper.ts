import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { scrapeZillow } from '../services/scraper';
import { appendToSheets, toSheetRows } from '../lib/googleSheets';
import { ensureMongo, ListingLog } from '../db/models';

const router = Router();

const Q = z.object({
  cityQuery: z.string().optional(),
  zipCodes: z.array(z.string()).optional(),
  maxPrice: z.number().optional(),
  minBedrooms: z.number().optional(),
  ownersOnly: z.boolean().optional().default(true),
  limit: z.number().optional().default(40)
});

router.post('/start', async (req: Request, res: Response) => {
  const parsed = Q.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const result = await scrapeZillow(parsed.data);

  try {
    if (process.env.GOOGLE_SHEETS_ID) {
      const keptRows = toSheetRows(result.included, 'KEPT');
      const dropRows = toSheetRows(result.excluded, 'DROPPED');
      if (keptRows.length) await appendToSheets(keptRows);
      if (dropRows.length) await appendToSheets(dropRows);
    }
  } catch {}

  try {
    if (process.env.MONGODB_URI) {
      await ensureMongo();
      const bulk = [
        ...result.included.map(d => ({ ...d, status: 'KEPT' as const })),
        ...result.excluded.map(d => ({ ...d, status: 'DROPPED' as const })),
      ];
      if (bulk.length) await ListingLog.insertMany(bulk, { ordered: false });
    }
  } catch {}

  res.json(result);
});

export default router;


