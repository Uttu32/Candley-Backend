import { Router } from 'express'
import { z } from 'zod'
import argon2 from 'argon2'
import { randomUUID } from 'node:crypto'
import { User } from '../models/User.js'
import { RefreshToken } from '../models/RefreshToken.js'
import { Announcement } from '../models/Announcement.js'
import { HeroSlide } from '../models/HeroSlide.js'
import { authenticate, requireRole } from '../middlewares/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/tokens.js'

const refreshCookie = 'candley_refresh_token'

const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
})

const announcementSchema = z.object({
  enabled: z.boolean().optional(),
  message: z.string().max(220).optional(),
  freeShippingEnabled: z.boolean().optional(),
  freeShippingThreshold: z.number().nonnegative().optional(),
  dismissible: z.boolean().optional(),
  ctaText: z.string().max(80).optional(),
  ctaUrl: z.string().max(255).optional(),
})

const heroSlideSchema = z.object({
  heading: z.string().min(2).max(120),
  subheading: z.string().min(2).max(220),
  ctaText: z.string().min(2).max(80).optional(),
  ctaUrl: z.string().min(1).max(255).optional(),
  desktopImage: z.string().optional(),
  mobileImage: z.string().optional(),
  backgroundVideo: z.string().optional(),
  overlayPosition: z.string().optional(),
  textAlignment: z.string().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

export const adminRouter = Router()

adminRouter.post('/login', asyncHandler(async (request, response) => {
  console.log("inside the admin login route", 'hurrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrayyyyyyyyyyyyyyyyyyyyy')
  const input = adminLoginSchema.parse(request.body)
  const user = await User.findOne({ email: input.email.toLowerCase() }).select('+passwordHash')
  console.log("========================================")
  console.log("Admin login attempt:", input.email)
  console.log("User found:", user ? "Yes" : "No", user)
  console.log("========================================")
  if (!user || !(await argon2.verify(user.passwordHash, input.password))) {
    throw new ApiError(401, 'Invalid admin credentials')
  }
  if (!['ADMIN', 'SUPER_ADMIN'].includes(user.role)) {
    throw new ApiError(403, 'Admin access required')
  }

  const tokenId = randomUUID()
  const accessToken = signAccessToken({ sub: user.id, role: user.role })
  const refreshToken = signRefreshToken({ sub: user.id, jti: tokenId })
  await RefreshToken.create({ userId: user.id, tokenId, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) })
  response.cookie(refreshCookie, refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    domain: process.env.COOKIE_DOMAIN || undefined,
  })

  sendSuccess(response, { accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role } }, 'Admin signed in')
}))

adminRouter.get('/me', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), asyncHandler(async (request, response) => {
  const user = await User.findById(request.auth!.sub).lean()
  if (!user) throw new ApiError(404, 'Admin account not found')
  sendSuccess(response, { id: user._id, name: user.name, email: user.email, role: user.role })
}))

adminRouter.put('/settings/announcement', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), asyncHandler(async (request, response) => {
  const input = announcementSchema.parse(request.body)
  const current = await Announcement.findOne()
  const next = current
    ? await Announcement.findByIdAndUpdate(current._id, { $set: input }, { new: true })
    : await Announcement.create({
        enabled: input.enabled ?? false,
        message: input.message ?? 'Free shipping on eligible orders',
        freeShippingEnabled: input.freeShippingEnabled ?? true,
        freeShippingThreshold: input.freeShippingThreshold ?? 1999,
        ...input,
      })
  sendSuccess(response, next, 'Announcement updated')
}))

adminRouter.get('/cms/hero', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), asyncHandler(async (_request, response) => {
  const slides = await HeroSlide.find().sort({ sortOrder: 1, createdAt: 1 }).lean()
  sendSuccess(response, slides)
}))

adminRouter.post('/cms/hero', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), asyncHandler(async (request, response) => {
  const payload = heroSlideSchema.parse(request.body)
  const slide = await HeroSlide.create(payload)
  sendSuccess(response, slide, 'Hero slide created', 201)
}))

adminRouter.patch('/cms/hero/:id', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), asyncHandler(async (request, response) => {
  const payload = heroSlideSchema.partial().parse(request.body)
  const slide = await HeroSlide.findByIdAndUpdate(request.params.id, { $set: payload }, { new: true })
  if (!slide) throw new ApiError(404, 'Hero slide not found')
  sendSuccess(response, slide, 'Hero slide updated')
}))

adminRouter.delete('/cms/hero/:id', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), asyncHandler(async (request, response) => {
  const slide = await HeroSlide.findByIdAndDelete(request.params.id)
  if (!slide) throw new ApiError(404, 'Hero slide not found')
  sendSuccess(response, null, 'Hero slide deleted')
}))

adminRouter.post('/logout', asyncHandler(async (request, response) => {
  const token = request.cookies?.[refreshCookie]
  if (token) {
    try {
      const claims = verifyRefreshToken(token)
      await RefreshToken.deleteOne({ tokenId: claims.jti })
    } catch {
      // no-op for expired/invalid tokens
    }
  }
  response.clearCookie(refreshCookie)
  sendSuccess(response, null, 'Admin signed out')
}))
