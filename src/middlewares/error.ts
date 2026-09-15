import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'
import { ApiError } from '../utils/api-error.js'
import { logger } from '../config/logger.js'

export const notFound: RequestHandler = (request, _response, next) => {
  next(new ApiError(404, `Route not found: ${request.method} ${request.path}`))
}

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof ZodError) {
    response.status(422).json({ success: false, message: 'Validation failed', errors: error.issues })
    return
  }
  if (error instanceof ApiError) {
    response.status(error.statusCode).json({ success: false, message: error.message, errors: error.details })
    return
  }
  logger.error({ error }, 'Unhandled request error')
  response.status(500).json({ success: false, message: 'Internal server error', errors: [] })
}
