# Zillow Assistant Backend

A powerful Node.js backend API for the Zillow Assistant automation platform. This backend handles property scraping, automated messaging, user management, and analytics for FRBO/FSBO property leads.

## Features

- 🔍 **Zillow Scraping**: Automated property data extraction with smart filtering
- 💬 **Messaging Automation**: Batch message sending with templates and personalization
- 🚫 **Red Flag Detection**: Smart filtering to avoid already rented/sold properties
- 📊 **Analytics & Tracking**: Performance metrics and response rate tracking
- 🔐 **User Management**: Secure authentication and user settings
- 📝 **Message Logging**: Complete audit trail with Google Sheets integration
- ⏰ **Scheduling**: Cron-based automation with rate limiting
- 🛡️ **Security**: Rate limiting, input validation, and secure headers

## Tech Stack

- **Node.js** with Express.js framework
- **MongoDB** with Mongoose ODM
- **Puppeteer** for web scraping
- **Cheerio** for HTML parsing
- **JWT** for authentication
- **Helmet** for security headers
- **Rate Limiter** for API protection
- **Node-Cron** for scheduling

## API Endpoints

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/register` - User registration
- `GET /api/auth/profile` - Get user profile

### Scraper
- `POST /api/scraper/search` - Start property search
- `GET /api/scraper/status` - Get scraper status
- `GET /api/scraper/listings` - Get scraped listings
- `POST /api/scraper/stop` - Stop running scraper

### Messages
- `GET /api/messages` - Get message history
- `POST /api/messages/send` - Send single message
- `POST /api/messages/send-batch` - Send batch messages
- `GET /api/messages/templates` - Get message templates
- `PUT /api/messages/templates/:id` - Update message template

### Analytics
- `GET /api/analytics/dashboard` - Dashboard statistics
- `GET /api/analytics/performance` - Performance metrics
- `GET /api/analytics/trends` - Trend analysis

### Settings
- `GET /api/settings` - Get user settings
- `PUT /api/settings` - Update user settings
- `POST /api/settings/zillow` - Configure Zillow credentials
- `POST /api/settings/sheets` - Configure Google Sheets

### Logs
- `GET /api/logs` - Get activity logs
- `POST /api/logs/export` - Export logs to Google Sheets

## Environment Variables

Create a `.env` file in the root directory:

```env
# Server Configuration
PORT=3001
NODE_ENV=development

# Database
MONGODB_URI=mongodb://localhost:27017/zillow-assistant

# JWT Secret
JWT_SECRET=your-super-secret-jwt-key

# Zillow Configuration
ZILLOW_BASE_URL=https://www.zillow.com

# Google Sheets API (optional)
GOOGLE_SHEETS_API_KEY=your-google-api-key
GOOGLE_CLIENT_EMAIL=your-service-account-email
GOOGLE_PRIVATE_KEY=your-private-key

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# Puppeteer Configuration
PUPPETEER_HEADLESS=true
PUPPETEER_TIMEOUT=30000
```

## Getting Started

### Prerequisites

- Node.js 16+ and npm
- MongoDB instance
- Git

### Installation

1. Clone the repository:
```bash
git clone https://github.com/PropertyPete1/Zillow-Assistant-Backend.git
cd Zillow-Assistant-Backend
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Start MongoDB (if running locally):
```bash
mongod
```

5. Start the development server:
```bash
npm run dev
```

The API will be available at `http://localhost:3001`

## Project Structure

```
src/
├── controllers/        # Request handlers
│   ├── auth.js
│   ├── scraper.js
│   ├── messages.js
│   ├── analytics.js
│   └── settings.js
├── middleware/         # Custom middleware
│   ├── auth.js
│   ├── rateLimiter.js
│   └── validation.js
├── models/            # Database schemas
│   ├── User.js
│   ├── Listing.js
│   ├── Message.js
│   └── Log.js
├── routes/            # API routes
│   ├── auth.js
│   ├── scraper.js
│   ├── messages.js
│   ├── analytics.js
│   └── settings.js
├── services/          # Business logic
│   ├── scraper.js
│   ├── messaging.js
│   ├── analytics.js
│   └── sheets.js
├── utils/             # Utility functions
│   ├── helpers.js
│   ├── validators.js
│   └── constants.js
└── server.js          # Main application file
```

## Available Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with nodemon
- `npm run build` - Build application (if needed)
- `npm test` - Run tests

## Scraping Features

### Smart Filtering
- Automatically detects "already rented" listings
- Filters out duplicate properties
- Identifies FRBO vs FSBO listings
- Skips properties without contact information

### Rate Limiting
- Respects Zillow's rate limits
- Implements exponential backoff
- Rotates user agents and headers
- Prevents IP blocking

### Data Extraction
- Property details (price, beds, baths, sqft)
- Owner/agent contact information
- Property photos and descriptions
- Listing history and status

## Messaging Features

### Template System
- Customizable message templates
- Dynamic variable replacement
- Property-type specific templates
- Personalization based on property details

### Batch Processing
- Send messages to multiple properties
- Smart queue management
- Failure handling and retries
- Progress tracking and reporting

### Analytics Integration
- Track message delivery status
- Monitor response rates
- A/B test different templates
- Performance optimization suggestions

## Security

- JWT-based authentication
- Rate limiting on all endpoints
- Input validation and sanitization
- Secure headers with Helmet
- CORS configuration
- Environment variable protection

## Deployment

### Production Setup

1. Set environment to production:
```env
NODE_ENV=production
```

2. Configure production database:
```env
MONGODB_URI=mongodb://your-production-db
```

3. Set strong JWT secret:
```env
JWT_SECRET=your-super-secure-production-secret
```

4. Deploy to your preferred platform (Heroku, AWS, DigitalOcean, etc.)

### Docker Support

```dockerfile
FROM node:16-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3001
CMD ["npm", "start"]
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is private and proprietary.

## Support

For support, please contact the development team or create an issue in the repository.

## API Documentation

Detailed API documentation is available at `/api/docs` when the server is running in development mode.
