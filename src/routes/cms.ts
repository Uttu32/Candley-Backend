import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../utils/async-handler.js'
import { sendSuccess } from '../utils/response.js'
import { Announcement } from '../models/Announcement.js'
import { HeroSlide } from '../models/HeroSlide.js'

export const cmsRouter = Router()

cmsRouter.get('/announcement', asyncHandler(async (_request, response) => {
  const announcement = await Announcement.findOne().lean()
  if (!announcement) {
    const fallback = { enabled: false, message: 'Free shipping on eligible orders', freeShippingEnabled: true, freeShippingThreshold: 1999 }
    return sendSuccess(response, fallback)
  }
  sendSuccess(response, announcement)
}))

cmsRouter.get('/hero', asyncHandler(async (_request, response) => {
  const slides = await HeroSlide.find({ active: true }).sort({ sortOrder: 1, createdAt: 1 }).lean()
  sendSuccess(response, slides)
}))
