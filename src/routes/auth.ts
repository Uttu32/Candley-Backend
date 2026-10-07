import { Router } from 'express'
import argon2 from 'argon2'
import { z } from 'zod'
import { env } from '../config/env.js'
import { User, toPublicUser } from '../models/User.js'
import { asyncHandler } from '../utils/async-handler.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'
import { createOpaqueToken, hashOpaqueToken } from '../utils/tokens.js'
import { authenticate } from '../middlewares/auth.js'
import { authLimiter } from '../middlewares/rate-limit.js'
import { endSession, issueSession, revokeAllSessions, rotateSession, verifyCredentials } from '../services/session.service.js'
import { mailTemplates, queueMail } from '../services/mailer.js'

const emailSchema = z.string().trim().toLowerCase().email().max(254)
// Upper bound protects the hashing step from oversized input.
const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(128)
const registerSchema = z.object({ name: z.string().trim().min(2).max(100), email: emailSchema, password: passwordSchema })
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) })
const profileSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: emailSchema,
  phone: z.string().trim().max(30).regex(/^[\d+\-\s()]*$/, 'Invalid phone number').default(''),
  dateOfBirth: z.string().trim().max(30).default(''),
})
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
const forgotPasswordSchema = z.object({ email: emailSchema })
const resetPasswordSchema = z.object({ token: z.string().regex(/^[a-f\d]{64}$/i, 'Invalid reset token'), password: passwordSchema })

const resetTokenTtlMs = 30 * 60_000

export const authRouter = Router()

authRouter.post('/register', authLimiter, asyncHandler(async (request, response) => {
  const input = registerSchema.parse(request.body)
  if (await User.exists({ email: input.email })) throw new ApiError(409, 'An account with this email already exists')
  // Role is never taken from the request; new accounts are always customers.
  const user = await User.create({ name: input.name, email: input.email, passwordHash: await argon2.hash(input.password), role: 'CUSTOMER' })
  sendSuccess(response, toPublicUser(user), 'Account created', 201)
}))

/** Shared login for customers and administrators. The role in the response comes from the database. */
authRouter.post('/login', authLimiter, asyncHandler(async (request, response) => {
  const input = loginSchema.parse(request.body)
  const user = await verifyCredentials(input.email, input.password)
  if (!user || user.status !== 'ACTIVE') throw new ApiError(401, 'Invalid email or password', [], 'INVALID_CREDENTIALS')
  const session = await issueSession(response, user)
  await User.updateOne({ _id: user.id }, { lastLoginAt: new Date() })
  sendSuccess(response, session, 'Signed in')
}))

authRouter.post('/refresh', authLimiter, asyncHandler(async (request, response) => {
  sendSuccess(response, await rotateSession(request, response), 'Token refreshed')
}))

authRouter.post('/logout', asyncHandler(async (request, response) => {
  await endSession(request, response)
  sendSuccess(response, null, 'Signed out')
}))

authRouter.get('/me', authenticate, asyncHandler(async (request, response) => {
  const user = await User.findById(request.auth!.sub).lean()
  if (!user) throw new ApiError(404, 'Account not found')
  sendSuccess(response, toPublicUser(user))
}))

authRouter.patch('/me', authenticate, asyncHandler(async (request, response) => {
  // Only these fields can be changed; role, status and other fields are stripped by the schema.
  const input = profileSchema.parse(request.body)
  const emailOwner = await User.exists({ email: input.email, _id: { $ne: request.auth!.sub } })
  if (emailOwner) throw new ApiError(409, 'That email is already in use')
  const current = await User.findById(request.auth!.sub).select('email').lean()
  if (!current) throw new ApiError(404, 'Account not found')
  const update = { name: input.name, email: input.email, phone: input.phone, dateOfBirth: input.dateOfBirth, ...(current.email !== input.email ? { emailVerified: false } : {}) }
  const user = await User.findByIdAndUpdate(request.auth!.sub, { $set: update }, { new: true, runValidators: true }).lean()
  sendSuccess(response, toPublicUser(user!), 'Profile updated')
}))

authRouter.post('/change-password', authenticate, authLimiter, asyncHandler(async (request, response) => {
  const input = changePasswordSchema.parse(request.body)
  const user = await User.findById(request.auth!.sub).select('+passwordHash')
  if (!user) throw new ApiError(404, 'Account not found')
  if (!(await argon2.verify(user.passwordHash, input.currentPassword).catch(() => false))) throw new ApiError(400, 'Current password is incorrect', [], 'INVALID_CREDENTIALS')
  user.passwordHash = await argon2.hash(input.newPassword)
  await user.save()
  await revokeAllSessions(user.id)
  const refreshed = await User.findById(user.id)
  // Issue a fresh session for this device; every other device must sign in again.
  sendSuccess(response, await issueSession(response, refreshed!), 'Password changed')
}))

/** Always returns the same response so the endpoint cannot be used to discover registered emails. */
authRouter.post('/forgot-password', authLimiter, asyncHandler(async (request, response) => {
  const { email } = forgotPasswordSchema.parse(request.body)
  const user = await User.findOne({ email, status: 'ACTIVE' })
  if (user) {
    const token = createOpaqueToken()
    await User.updateOne({ _id: user.id }, { $set: { passwordResetTokenHash: hashOpaqueToken(token), passwordResetExpiresAt: new Date(Date.now() + resetTokenTtlMs) } })
    const link = `${env.CLIENT_URL.replace(/\/$/, '')}/reset-password?token=${token}`
    queueMail({ to: user.email, ...mailTemplates.passwordReset(user.name, link) })
  }
  sendSuccess(response, null, 'If an account exists for that email, a reset link has been sent')
}))

authRouter.post('/reset-password', authLimiter, asyncHandler(async (request, response) => {
  const input = resetPasswordSchema.parse(request.body)
  const user = await User.findOneAndUpdate(
    { passwordResetTokenHash: hashOpaqueToken(input.token), passwordResetExpiresAt: { $gt: new Date() }, status: 'ACTIVE' },
    { $set: { passwordHash: await argon2.hash(input.password) }, $unset: { passwordResetTokenHash: 1, passwordResetExpiresAt: 1 } },
    { new: true },
  )
  if (!user) throw new ApiError(400, 'Reset link is invalid or has expired', [], 'RESET_TOKEN_INVALID')
  await revokeAllSessions(user.id)
  sendSuccess(response, null, 'Password has been reset. Please sign in.')
}))
