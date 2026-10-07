import { randomUUID } from 'node:crypto'
import type { CookieOptions, Request, Response } from 'express'
import argon2 from 'argon2'
import { env, isProduction } from '../config/env.js'
import { RefreshToken } from '../models/RefreshToken.js'
import { User, toPublicUser, type UserDocument } from '../models/User.js'
import { ApiError } from '../utils/api-error.js'
import { refreshTokenTtlMs, signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/tokens.js'

export const refreshCookieName = 'candley_refresh_token'

const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  domain: env.COOKIE_DOMAIN || undefined,
  path: '/',
})

// Computed lazily so tests can run without the value being fixed at import time.
let refreshTtl: number | undefined
const ttl = () => (refreshTtl ??= refreshTokenTtlMs())

/** Dummy hash used to keep login timing similar whether or not the email exists. */
let dummyHash: Promise<string> | undefined
const getDummyHash = () => (dummyHash ??= argon2.hash('candley-aroma-timing-equaliser'))

export const verifyCredentials = async (email: string, password: string) => {
  const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+passwordHash')
  if (!user) {
    await argon2.verify(await getDummyHash(), password).catch(() => false)
    return null
  }
  const valid = await argon2.verify(user.passwordHash, password).catch(() => false)
  return valid ? user : null
}

export const issueSession = async (response: Response, user: UserDocument) => {
  const tokenId = randomUUID()
  const accessToken = signAccessToken({ sub: user.id, role: user.role, ver: user.tokenVersion ?? 0 })
  const refreshToken = signRefreshToken({ sub: user.id, jti: tokenId })
  await RefreshToken.create({ userId: user.id, tokenId, expiresAt: new Date(Date.now() + ttl()) })
  response.cookie(refreshCookieName, refreshToken, { ...cookieOptions(), maxAge: ttl() })
  return { accessToken, user: toPublicUser(user) }
}

export const rotateSession = async (request: Request, response: Response) => {
  const token = request.cookies?.[refreshCookieName]
  if (!token) throw new ApiError(401, 'Refresh token required')
  let claims
  try {
    claims = verifyRefreshToken(token)
  } catch {
    clearSessionCookie(response)
    throw new ApiError(401, 'Refresh token invalid or expired')
  }
  const stored = await RefreshToken.findOneAndDelete({ tokenId: claims.jti, userId: claims.sub })
  if (!stored) {
    // A revoked token being replayed may indicate theft: revoke every session for this account.
    await RefreshToken.deleteMany({ userId: claims.sub })
    clearSessionCookie(response)
    throw new ApiError(401, 'Refresh token revoked')
  }
  const user = await User.findById(claims.sub)
  if (!user || user.status !== 'ACTIVE') {
    clearSessionCookie(response)
    throw new ApiError(401, 'Account unavailable')
  }
  return issueSession(response, user)
}

export const endSession = async (request: Request, response: Response) => {
  const token = request.cookies?.[refreshCookieName]
  if (token) {
    try {
      const claims = verifyRefreshToken(token)
      await RefreshToken.deleteOne({ tokenId: claims.jti })
    } catch {
      // An invalid or expired refresh token is already unusable; only the cookie needs clearing.
    }
  }
  clearSessionCookie(response)
}

export const clearSessionCookie = (response: Response) => response.clearCookie(refreshCookieName, cookieOptions())

/** Invalidates all access and refresh tokens for a user (password change/reset, blocking). */
export const revokeAllSessions = async (userId: string) => {
  await Promise.all([
    User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } }),
    RefreshToken.deleteMany({ userId }),
  ])
}
