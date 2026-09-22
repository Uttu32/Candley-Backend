import type { NextFunction, Request, Response } from 'express'
import { ApiError } from '../utils/api-error.js'
import { verifyAccessToken } from '../utils/tokens.js'

export const authenticate = (request: Request, _response: Response, next: NextFunction) => {
  console.log("I am inside the authenticate middleware")
  const token = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : undefined
  if (!token) return next(new ApiError(401, 'Authentication required'))
  try {
    request.auth = verifyAccessToken(token)
    next()
  } catch {
    next(new ApiError(401, 'Invalid or expired access token'))
  }
}

export const requireRole = (...roles: string[]) => (request: Request, _response: Response, next: NextFunction) => {
  if (!request.auth || !roles.includes(request.auth.role)) return next(new ApiError(403, 'Insufficient permissions'))
  next()
}
