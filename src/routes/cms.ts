import { Router } from 'express'
import { asyncHandler } from '../utils/async-handler.js'
import { sendSuccess } from '../utils/response.js'
import { Announcement } from '../models/Announcement.js'
import { HeroSlide } from '../models/HeroSlide.js'
import { getStoreSettings } from '../models/StoreSettings.js'
import { isRazorpayConfigured } from '../config/env.js'

export const cmsRouter = Router()

cmsRouter.get('/announcement', asyncHandler(async (_request, response) => {
  const announcement = await Announcement.findOne().lean()
  if (!announcement) {
    const fallback = { enabled: false, message: 'Free shipping on eligible orders', freeShippingEnabled: true, freeShippingThreshold: 1999 }
    return sendSuccess(response, fallback)
  }
  sendSuccess(response, announcement)
}))

/** Query matching slides that are active, inside their publication window, and have at least one media source. */
export const displayableSlidesFilter = (now: Date) => ({
  active: true,
  $and: [
    { $or: [{ startsAt: null }, { startsAt: { $exists: false } }, { startsAt: { $lte: now } }] },
    { $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gt: now } }] },
    { $or: [{ desktopImage: { $nin: ['', null] } }, { desktopVideo: { $nin: ['', null] } }, { backgroundVideo: { $nin: ['', null] } }] },
  ],
})

cmsRouter.get('/hero', asyncHandler(async (_request, response) => {
  const slides = await HeroSlide.find(displayableSlidesFilter(new Date())).sort({ sortOrder: 1, createdAt: 1 }).lean()
  response.setHeader('Cache-Control', 'public, max-age=60')
  sendSuccess(response, slides)
}))

/** Public store rules the storefront needs to render checkout options. No secrets. */
cmsRouter.get('/checkout-options', asyncHandler(async (_request, response) => {
  const settings = await getStoreSettings()
  sendSuccess(response, {
    codEnabled: settings.codEnabled,
    codMaxOrderValue: settings.codMaxOrderValue ?? null,
    razorpayEnabled: isRazorpayConfigured,
    shippingFee: settings.shippingFee,
    freeShippingThreshold: settings.freeShippingThreshold,
    maxQuantityPerItem: settings.maxQuantityPerItem,
  })
}))
