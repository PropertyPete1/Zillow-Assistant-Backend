import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

import scraperRoutes from './routes/scraper';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_: Request, res: Response) => res.json({ ok: true, ts: new Date().toISOString() }));
app.use('/api/scraper', scraperRoutes);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});


