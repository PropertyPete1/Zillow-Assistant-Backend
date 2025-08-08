import express from 'express';

const router = express.Router();

// Mock scraper state
let scraperState = {
  isRunning: false,
  lastRun: new Date().toISOString(),
  totalListings: 47,
  status: 'idle'
};

// Start property search
router.post('/search', async (req, res) => {
  try {
    const { city, zipCode, listingType, filters } = req.body;
    
    // Set scraper to running state
    scraperState = {
      ...scraperState,
      isRunning: true,
      status: 'running',
      lastRun: new Date().toISOString()
    };
    
    // TODO: Implement actual scraping logic with Puppeteer
    res.json({
      success: true,
      message: 'Scraper started successfully',
      searchParams: {
        city,
        zipCode,
        listingType,
        filters
      },
      status: scraperState
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to start scraper',
      error: error.message
    });
  }
});

// Get scraper status
router.get('/status', async (req, res) => {
  try {
    res.json({
      success: true,
      status: scraperState
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get scraper status',
      error: error.message
    });
  }
});

// Get scraped listings
router.get('/listings', async (req, res) => {
  try {
    // TODO: Get actual listings from database
    const mockListings = [
      {
        id: 1,
        address: '123 Oak St',
        price: '$2,400',
        beds: 3,
        baths: 2,
        sqft: 1200,
        type: 'rent',
        owner: 'Sarah Johnson',
        contactInfo: 'sarah@email.com',
        status: 'ready',
        dateScraped: new Date().toISOString()
      },
      {
        id: 2,
        address: '456 Pine Ave',
        price: '$450,000',
        beds: 4,
        baths: 3,
        sqft: 2100,
        type: 'sale',
        owner: 'Mike Chen',
        contactInfo: 'mike@email.com',
        status: 'sent',
        dateScraped: new Date().toISOString()
      }
    ];
    
    res.json({
      success: true,
      listings: mockListings,
      total: mockListings.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get listings',
      error: error.message
    });
  }
});

// Stop scraper
router.post('/stop', async (req, res) => {
  try {
    scraperState = {
      ...scraperState,
      isRunning: false,
      status: 'stopped'
    };
    
    res.json({
      success: true,
      message: 'Scraper stopped successfully',
      status: scraperState
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to stop scraper',
      error: error.message
    });
  }
});

export default router;
