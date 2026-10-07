import type { NextFunction, Request, Response } from 'express'
import { ApiError } from '../utils/api-error.js'
import { verifyAccessToken } from '../utils/tokens.js'
import { User, type UserRole } from '../models/User.js'

const readBearer = (request: Request) => {
  const header = request.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined
}

/**
 * Verifies the access token, then loads the account so that role, status and
 * token version come from the database rather than from the token.
 */
export const authenticate = async (request: Request, _response: Response, next: NextFunction) => {
  const token = readBearer(request)
  if (!token) return next(new ApiError(401, 'Authentication required'))
  let claims
  try {
    claims = verifyAccessToken(token)
  } catch {
    return next(new ApiError(401, 'Invalid or expired access token', [], 'TOKEN_INVALID'))
  }
  try {
    const user = await User.findById(claims.sub).select('role status tokenVersion').lean()
    if (!user || user.status !== 'ACTIVE' || (user.tokenVersion ?? 0) !== (claims.ver ?? 0)) {
      return next(new ApiError(401, 'Session is no longer valid', [], 'TOKEN_REVOKED'))
    }
    request.auth = { ...claims, role: user.role }
    next()
  } catch (error) {
    next(error)
  }
}

export const requireRole = (...roles: UserRole[]) => (request: Request, _response: Response, next: NextFunction) => {
  if (!request.auth || !roles.includes(request.auth.role as UserRole)) return next(new ApiError(403, 'Insufficient permissions'))
  next()
}

export const requireAdmin = requireRole('ADMIN', 'SUPER_ADMIN')

/** Populates `request.auth` when a valid token is present, but never rejects the request. */
export const optionalAuthenticate = async (request: Request, response: Response, next: NextFunction) => {
  if (!readBearer(request)) return next()
  await authenticate(request, response, (error?: unknown) => {
    if (error) delete request.auth
    next()
  })
}

export const isAdminRequest = (request: Request) => request.auth?.role === 'ADMIN' || request.auth?.role === 'SUPER_ADMIN'
