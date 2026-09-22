import type { ErrorRequestHandler, RequestHandler } from 'express'
import multer from 'multer'
import { ZodError } from 'zod'
import { ApiError } from '../utils/api-error.js'
import { logger } from '../config/logger.js'

export const notFound: RequestHandler = (request, _response, next) => {
  next(new ApiError(404, `Route not found: ${request.method} ${request.path}`))
}

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  if (error instanceof ZodError) {
    response.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: error.issues } })
    return
  }
  if (error instanceof multer.MulterError) {
    response.status(400).json({ success: false, error: { code: 'UPLOAD_ERROR', message: error.message } })
    return
  }
  if (error?.name === 'ValidationError') {
    response.status(400).json({ success: false, error: { code: 'DATABASE_VALIDATION_ERROR', message: 'Invalid request data' } })
    return
  }
  if (error?.code === 11000) {
    response.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'A record with those values already exists' } })
    return
  }
  if (error instanceof ApiError) {
    response.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message, details: error.details } })
    return
  }
  if (error?.name === 'CastError') {
    response.status(400).json({ success: false, error: { code: 'INVALID_IDENTIFIER', message: 'Invalid identifier' } })
    return
  }
  logger.error({ error, method: request.method, path: request.path, params: request.params, query: request.query }, 'Unhandled request error')
  response.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
}
