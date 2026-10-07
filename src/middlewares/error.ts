import type { ErrorRequestHandler, RequestHandler } from 'express'
import multer from 'multer'
import { ZodError } from 'zod'
import { ApiError } from '../utils/api-error.js'
import { logger } from '../config/logger.js'

export const notFound: RequestHandler = (request, _response, next) => {
  next(new ApiError(404, `Route not found: ${request.method} ${request.path}`, [], 'ROUTE_NOT_FOUND'))
}

/**
 * Error envelope: `{ success: false, message, error: { code, message, details } }`.
 * The top-level `message` is what the frontend API client displays.
 */
const send = (response: Parameters<ErrorRequestHandler>[2], status: number, code: string, message: string, details?: unknown) => {
  response.status(status).json({ success: false, message, error: { code, message, ...(details === undefined ? {} : { details }) } })
}

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    const first = details[0]
    send(response, 400, 'VALIDATION_ERROR', first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'Validation failed', details)
    return
  }
  if (error instanceof multer.MulterError) {
    send(response, error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'UPLOAD_ERROR', error.message)
    return
  }
  if (error instanceof ApiError) {
    send(response, error.statusCode, error.code, error.message, error.details.length ? error.details : undefined)
    return
  }
  if (error?.type === 'entity.parse.failed') {
    send(response, 400, 'INVALID_JSON', 'Request body is not valid JSON')
    return
  }
  if (error?.type === 'entity.too.large') {
    send(response, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large')
    return
  }
  if (error?.name === 'ValidationError') {
    send(response, 400, 'DATABASE_VALIDATION_ERROR', 'Invalid request data')
    return
  }
  if (error?.code === 11000) {
    const fields = Object.keys(error.keyPattern ?? {})
    send(response, 409, 'CONFLICT', fields.length ? `A record with this ${fields.join(', ')} already exists` : 'A record with those values already exists')
    return
  }
  if (error?.name === 'CastError') {
    send(response, 400, 'INVALID_IDENTIFIER', 'Invalid identifier')
    return
  }
  if (error?.message === 'Not allowed by CORS') {
    send(response, 403, 'CORS_REJECTED', 'Origin not allowed')
    return
  }
  logger.error({ err: error, method: request.method, path: request.path }, 'Unhandled request error')
  send(response, 500, 'INTERNAL_ERROR', 'Internal server error')
}
