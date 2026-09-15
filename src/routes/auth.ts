import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import argon2 from 'argon2'
import { z } from 'zod'
import { User } from '../models/User.js'
import { RefreshToken } from '../models/RefreshToken.js'
import { asyncHandler } from '../utils/async-handler.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/tokens.js'
import { authenticate } from '../middlewares/auth.js'

const credentialsSchema = z.object({ name: z.string().min(2).max(100).optional(), email: z.string().email(), password: z.string().min(8).max(128) })
const profileSchema = z.object({ name: z.string().min(2).max(100), email: z.string().email(), phone: z.string().max(30), dateOfBirth: z.string().max(30) })
const refreshCookie = 'candley_refresh_token'

export const authRouter = Router()

authRouter.get('/me', authenticate, asyncHandler(async (request, response) => {
  const user = await User.findById(request.auth!.sub).lean()
  if (!user) throw new ApiError(404, 'Account not found')
  sendSuccess(response, { id: user._id, name: user.name, email: user.email, phone: user.phone ?? '', dateOfBirth: user.dateOfBirth ?? '', role: user.role, emailVerified: user.emailVerified })
}))

authRouter.patch('/me', authenticate, asyncHandler(async (request, response) => {
  const input = profileSchema.parse(request.body)
  const emailOwner = await User.findOne({ email: input.email.toLowerCase(), _id: { $ne: request.auth!.sub } })
  if (emailOwner) throw new ApiError(409, 'That email is already in use')
  const user = await User.findByIdAndUpdate(request.auth!.sub, { $set: { ...input, email: input.email.toLowerCase() } }, { new: true }).lean()
  if (!user) throw new ApiError(404, 'Account not found')
  sendSuccess(response, { id: user._id, name: user.name, email: user.email, phone: user.phone ?? '', dateOfBirth: user.dateOfBirth ?? '', role: user.role, emailVerified: user.emailVerified }, 'Profile updated')
}))

authRouter.post('/register', asyncHandler(async (request, response) => {
  const input = credentialsSchema.parse(request.body)
  if (!input.name) throw new ApiError(422, 'Name is required')
  const exists = await User.exists({ email: input.email.toLowerCase() })
  if (exists) throw new ApiError(409, 'An account with this email already exists')
  const user = await User.create({ name: input.name, email: input.email.toLowerCase(), passwordHash: await argon2.hash(input.password) })
  sendSuccess(response, { id: user.id, name: user.name, email: user.email }, 'Account created', 201)
}))

authRouter.post('/login', asyncHandler(async (request, response) => {
  const input = credentialsSchema.pick({ email: true, password: true }).parse(request.body)
  const user = await User.findOne({ email: input.email.toLowerCase() }).select('+passwordHash')
  if (!user || !(await argon2.verify(user.passwordHash, input.password))) throw new ApiError(401, 'Invalid email or password')
  if (user.status !== 'ACTIVE') throw new ApiError(403, 'This account is not active')
  const tokenId = randomUUID()
  const accessToken = signAccessToken({ sub: user.id, role: user.role })
  const refreshToken = signRefreshToken({ sub: user.id, jti: tokenId })
  await RefreshToken.create({ userId: user.id, tokenId, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) })
  response.cookie(refreshCookie, refreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', domain: process.env.COOKIE_DOMAIN || undefined, maxAge: 7 * 24 * 60 * 60 * 1000 })
  await User.updateOne({ _id: user.id }, { lastLoginAt: new Date() })
  sendSuccess(response, { accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role } }, 'Signed in')
}))

authRouter.post('/refresh', asyncHandler(async (request, response) => {
  const token = request.cookies?.[refreshCookie]
  if (!token) throw new ApiError(401, 'Refresh token required')
  const claims = verifyRefreshToken(token)
  const stored = await RefreshToken.findOneAndDelete({ tokenId: claims.jti, userId: claims.sub })
  if (!stored) throw new ApiError(401, 'Refresh token revoked')
  const user = await User.findById(claims.sub)
  if (!user || user.status !== 'ACTIVE') throw new ApiError(401, 'Account unavailable')
  const tokenId = randomUUID()
  const nextRefreshToken = signRefreshToken({ sub: user.id, jti: tokenId })
  await RefreshToken.create({ userId: user.id, tokenId, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) })
  response.cookie(refreshCookie, nextRefreshToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 })
  sendSuccess(response, { accessToken: signAccessToken({ sub: user.id, role: user.role }) }, 'Token refreshed')
}))

authRouter.post('/logout', asyncHandler(async (request, response) => {
  const token = request.cookies?.[refreshCookie]
  if (token) { try { const claims = verifyRefreshToken(token); await RefreshToken.deleteOne({ tokenId: claims.jti }) } catch { /* expired token is already unusable */ } }
  response.clearCookie(refreshCookie)
  sendSuccess(response, null, 'Signed out')
}))
