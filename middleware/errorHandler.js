/** Error Handling Middleware */
const { logger } = require('../config/logger');

/**
 * Custom Error Classes
 */
class AppError extends Error {
  constructor(message, statusCode, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message) {
    super(message, 400);
    this.name = 'ValidationError';
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
    this.name = 'UnauthorizedError';
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource conflict') {
    super(message, 409);
    this.name = 'ConflictError';
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Rate limit exceeded') {
    super(message, 429);
    this.name = 'RateLimitError';
  }
}

class InternalServerError extends AppError {
  constructor(message = 'Internal server error') {
    super(message, 500);
    this.name = 'InternalServerError';
    this.isOperational = false;
  }
}

/**
 * Error Handler Middleware
 */
function errorHandler(err, req, res, next) {

  if (err.isOperational) {
    logger.warn(`[Error Handler] Operational error: ${err.message}`, {
      statusCode: err.statusCode,
      path: req.path,
      method: req.method,
      ip: req.ip
    });
  } else {
    logger.error(`[Error Handler] Unexpected error: ${err.message}`, {
      statusCode: err.statusCode,
      path: req.path,
      method: req.method,
      ip: req.ip,
      stack: err.stack
    });
  }

  const statusCode = err.statusCode || 500;

  const isProd = process.env.NODE_ENV === 'production';
  const safeMessage = (err.isOperational && statusCode < 500)
    ? (err.message || 'Permintaan tidak dapat diproses.')
    : (isProd
      ? 'Terjadi kesalahan pada server. Silakan coba lagi atau hubungi admin.'
      : (err.message || 'Internal server error'));
  const safeType = (err.isOperational && statusCode < 500) ? (err.name || 'Error') : 'Error';

  const isApi = req.path.startsWith('/api/');
  const wantsJsonType = req.headers['content-type'] === 'application/json';
  const bestMatch = req.accepts(['html', 'json']);
  const isJson = wantsJsonType || bestMatch === 'json';

  if (isApi || isJson) {

    res.status(statusCode).json({
      success: false,
      error: {
        message: safeMessage,
        type: safeType,
        statusCode: statusCode,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
      }
    });
  } else {

    const errorMessage = safeMessage;
    const errorTitle = safeType;

    if (req.session) {
      req.session._msg = {
        type: 'error',
        text: errorMessage
      };
    }

    if (req.accepts('html') && !req.xhr) {

      res.status(statusCode).render('error', {
        title: `${statusCode} - ${errorTitle}`,
        error: errorMessage,
        statusCode: statusCode
      });
    } else {

      res.status(statusCode).send(`${statusCode} - ${errorMessage}`);
    }
  }
}

/**
 * 404 Not Found Handler
 */
function notFoundHandler(req, res, next) {
  const isApi = req.path.startsWith('/api/');
  const wantsJsonType = req.headers['content-type'] === 'application/json';
  const bestMatch = req.accepts(['html', 'json']);
  const isJson = wantsJsonType || bestMatch === 'json';

  if (isApi || isJson) {
    res.status(404).json({
      success: false,
      error: {
        message: 'Resource not found',
        type: 'NotFoundError',
        statusCode: 404,
        path: req.path
      }
    });
  } else {
    if (req.session) {
      req.session._msg = {
        type: 'error',
        text: 'Halaman tidak ditemukan'
      };
    }
    res.status(404).render('error', {
      title: '404 - Not Found',
      error: 'Halaman yang Anda cari tidak ditemukan',
      statusCode: 404
    });
  }
}

/** Async Error Wrapper */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Validation Helper */
function validateInput(data, schema) {
  const errors = [];

  for (const [field, rules] of Object.entries(schema)) {
    const value = data[field];

    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field} is required`);
      continue;
    }

    if (!rules.required && (value === undefined || value === null || value === '')) {
      continue;
    }

    if (rules.type) {
      if (rules.type === 'string' && typeof value !== 'string') {
        errors.push(`${field} must be a string`);
      } else if (rules.type === 'number' && typeof value !== 'number') {
        errors.push(`${field} must be a number`);
      } else if (rules.type === 'email' && typeof value === 'string') {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(value)) {
          errors.push(`${field} must be a valid email`);
        }
      } else if (rules.type === 'phone' && typeof value === 'string') {
        const phoneRegex = /^[\d\s\-\+]+$/;
        if (!phoneRegex.test(value)) {
          errors.push(`${field} must be a valid phone number`);
        }
      }
    }

    if (rules.minLength && typeof value === 'string' && value.length < rules.minLength) {
      errors.push(`${field} must be at least ${rules.minLength} characters`);
    }

    if (rules.maxLength && typeof value === 'string' && value.length > rules.maxLength) {
      errors.push(`${field} must be at most ${rules.maxLength} characters`);
    }

    if (rules.min !== undefined && typeof value === 'number' && value < rules.min) {
      errors.push(`${field} must be at least ${rules.min}`);
    }

    if (rules.max !== undefined && typeof value === 'number' && value > rules.max) {
      errors.push(`${field} must be at most ${rules.max}`);
    }

    if (rules.pattern && typeof value === 'string') {
      if (!rules.pattern.test(value)) {
        errors.push(`${field} format is invalid`);
      }
    }

    if (rules.validate && typeof rules.validate === 'function') {
      const result = rules.validate(value);
      if (result !== true) {
        errors.push(result || `${field} is invalid`);
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(errors.join(', '));
  }

  return true;
}

module.exports = {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  validateInput,
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InternalServerError
};
