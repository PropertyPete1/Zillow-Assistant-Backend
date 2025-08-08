// Global error handling middleware
export const errorHandler = (err, req, res, next) => {
  console.error('❌ Error:', err);

  // Default error
  let error = {
    status: err.statusCode || 500,
    message: err.message || 'Internal Server Error',
    timestamp: new Date().toISOString(),
    path: req.originalUrl,
    method: req.method
  };

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map(val => val.message);
    error = {
      ...error,
      status: 400,
      message: 'Validation Error',
      details: errors
    };
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    error = {
      ...error,
      status: 400,
      message: `Duplicate value for field: ${field}`
    };
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    error = {
      ...error,
      status: 401,
      message: 'Invalid token'
    };
  }

  if (err.name === 'TokenExpiredError') {
    error = {
      ...error,
      status: 401,
      message: 'Token expired'
    };
  }

  // Cast error (invalid ObjectId)
  if (err.name === 'CastError') {
    error = {
      ...error,
      status: 400,
      message: 'Invalid ID format'
    };
  }

  // Don't expose stack trace in production
  if (process.env.NODE_ENV === 'development') {
    error.stack = err.stack;
  }

  res.status(error.status).json({ error });
};
