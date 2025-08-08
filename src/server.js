import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

// Import routes
import authRoutes from './routes/auth.js';
import scraperRoutes from './routes/scraper.js';
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

// Security middleware
app.use(helmet());
const allowedOrigins = (() => {
  const fromEnv = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  if (process.env.NODE_ENV === 'production') return ['https://your-frontend-domain.com'];
  return ['http://localhost:3000', 'http://localhost:5173'];
})();
app.use(cors({ origin: allowedOrigins, credentials: true }));

// Rate limiting
app.use(rateLimiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/scraper', scraperRoutes);
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

// Database connection
const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/zillow-assistant';
    await mongoose.connect(mongoURI);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Start server
const startServer = async () => {
  try {
    await connectDB();
    
    app.listen(PORT, () => {
      console.log(`🚀 Zillow Assistant Backend running on port ${PORT}`);
      console.log(`📋 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔗 Health check: http://localhost:${PORT}/health`);
      if (process.env.NODE_ENV === 'development') {
        console.log(`📚 API docs: http://localhost:${PORT}/api/docs`);
      }
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

export default app;
