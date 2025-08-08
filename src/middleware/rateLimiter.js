import { RateLimiterMemory } from 'rate-limiter-flexible';

// Create rate limiter instance
const rateLimiter = new RateLimiterMemory({
  points: process.env.RATE_LIMIT_MAX_REQUESTS || 100, // Number of requests
  duration: Math.floor((process.env.RATE_LIMIT_WINDOW_MS || 900000) / 1000), // Per 15 minutes (in seconds)
  blockDuration: 60, // Block for 60 seconds if limit exceeded
});

// Express middleware wrapper
export const rateLimiterMiddleware = async (req, res, next) => {
  try {
    // Get client identifier (IP address)
    const key = req.ip || req.connection.remoteAddress;
    
    // Check rate limit
    await rateLimiter.consume(key);
    
    // Add rate limit headers
    const resRateLimiter = await rateLimiter.get(key);
    const remainingPoints = resRateLimiter ? resRateLimiter.remainingPoints : rateLimiter.points;
    const msBeforeNext = resRateLimiter ? resRateLimiter.msBeforeNext : 0;
    
    res.set({
      'X-RateLimit-Limit': rateLimiter.points,
      'X-RateLimit-Remaining': remainingPoints,
      'X-RateLimit-Reset': new Date(Date.now() + msBeforeNext).toISOString(),
    });
    
    next();
  } catch (rejRes) {
    // Rate limit exceeded
    const secs = Math.round(rejRes.msBeforeNext / 1000) || 1;
    
    res.set({
      'X-RateLimit-Limit': rateLimiter.points,
      'X-RateLimit-Remaining': 0,
      'X-RateLimit-Reset': new Date(Date.now() + rejRes.msBeforeNext).toISOString(),
      'Retry-After': String(secs),
    });
    
    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Please try again in ${secs} seconds.`,
      retryAfter: secs,
      timestamp: new Date().toISOString()
    });
  }
};

// Export as named export for consistency
export { rateLimiterMiddleware as rateLimiter };
