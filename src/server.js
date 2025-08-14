import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

// Import routes
import authRoutes from './routes/auth.js';
// Legacy scraper removed from public API to avoid 403/CAPTCHA flows
// import scraperRoutes from './routes/scraper.js';
import leadsRoutes from './routes/leads.js';
import messagesRoutes from './routes/messages.js';
import analyticsRoutes from './routes/analytics.js';
import settingsRoutes from './routes/settings.js';
import logsRoutes from './routes/logs.js';

// Import middleware
import { rateLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// CORS first so preflight never hits helmet restrictions
const parseOriginPatterns = () => {
  // Always allow Vercel previews and common local dev hosts
  const base = ['https://*.vercel.app', 'http://localhost:3000', 'http://localhost:5173', 'chrome-extension://*'];
  const envList = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  // De-dupe while preserving order
  const set = new Set([...envList, ...base]);
  return Array.from(set);
};

const originPatterns = parseOriginPatterns();
const isOriginAllowed = (origin) => {
  if (!origin) return true; // non-browser or same-origin
  for (const patt of originPatterns) {
    if (patt.includes('*')) {
      const re = new RegExp('^' + patt.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      if (re.test(origin)) return true;
    } else {
      if (origin === patt) return true;
    }
  }
  return false;
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Security middleware
app.use(helmet());

// Rate limiting
app.use(rateLimiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

let isDbConnected = false;
mongoose.connection.on('connected', () => { isDbConnected = true; console.log('✅ Mongo connected'); });
mongoose.connection.on('error', (err) => { isDbConnected = false; console.error('❌ Mongo error:', err); });
mongoose.connection.on('disconnected', () => { isDbConnected = false; console.warn('⚠️ Mongo disconnected'); });

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    dbConnected: isDbConnected,
  });
});

// Alias for extension/frontend compatibility
app.get('/api/leads/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    dbConnected: isDbConnected,
  });
});

// API routes
app.use('/api/auth', authRoutes);
// app.use('/api/scraper', scraperRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/logs', logsRoutes);

// API documentation (development only)
if (process.env.NODE_ENV === 'development') {
  app.get('/api/docs', (req, res) => {
    res.json({
      title: 'Zillow Assistant API',
      version: '1.0.0',
      description: 'Backend API for Zillow Assistant automation platform',
      endpoints: {
        auth: {
          'POST /api/auth/login': 'User login',
          'POST /api/auth/register': 'User registration',
          'GET /api/auth/profile': 'Get user profile'
        },
        scraper: {
          'POST /api/scraper/search': 'Start property search',
          'GET /api/scraper/status': 'Get scraper status',
          'GET /api/scraper/listings': 'Get scraped listings',
          'POST /api/scraper/stop': 'Stop running scraper'
        },
        messages: {
          'GET /api/messages': 'Get message history',
          'POST /api/messages/send': 'Send single message',
          'POST /api/messages/send-batch': 'Send batch messages',
          'GET /api/messages/templates': 'Get message templates'
        },
        analytics: {
          'GET /api/analytics/dashboard': 'Dashboard statistics',
          'GET /api/analytics/performance': 'Performance metrics',
          'GET /api/analytics/trends': 'Trend analysis'
        },
        settings: {
          'GET /api/settings': 'Get user settings',
          'PUT /api/settings': 'Update user settings'
        },
        logs: {
          'GET /api/logs': 'Get activity logs',
          'POST /api/logs/export': 'Export logs to Google Sheets'
        }
      }
    });
  });
}

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`,
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use(errorHandler);

// Database connection (non-blocking)
const connectDB = async () => {
  const mongoURI = process.env.MONGODB_URI;
  if (!mongoURI) {
    console.warn('⚠️ MONGODB_URI not set. Server will start without DB connection.');
    return;
  }
  try {
    await mongoose.connect(mongoURI, { serverSelectionTimeoutMS: 10000 });
  } catch (error) {
    console.error('❌ MongoDB connection error:', error?.message || error);
    // Do not exit; keep API up for health/config endpoints
  }
};

// Start server immediately; connect to DB in background
app.listen(PORT, () => {
  console.log(`🚀 Zillow Assistant Backend running on port ${PORT}`);
  console.log(`📋 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  if (process.env.NODE_ENV === 'development') {
    console.log(`📚 API docs: http://localhost:${PORT}/api/docs`);
  }
});

connectDB();

export default app;
