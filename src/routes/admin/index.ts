import { Router } from 'express'
import { z } from 'zod'
import { User, toPublicUser } from '../../models/User.js'
import { Announcement } from '../../models/Announcement.js'
import { Order } from '../../models/Order.js'
import { Product } from '../../models/Product.js'
import { StoreSettings, getStoreSettings } from '../../models/StoreSettings.js'
import { authenticate, requireAdmin } from '../../middlewares/auth.js'
import { authLimiter } from '../../middlewares/rate-limit.js'
import { createSignedUpload, mediaFolders } from '../../config/cloudinary.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { ApiError } from '../../utils/api-error.js'
import { sendSuccess } from '../../utils/response.js'
import { safeLinkSchema } from '../../utils/validation.js'
import { endSession, issueSession, verifyCredentials } from '../../services/session.service.js'
import { adminProductsRouter } from './products.js'
import { adminHeroRouter } from './hero.js'
import { adminOrdersRouter } from './orders.js'
import { adminCustomersRouter } from './customers.js'
import { adminCategoriesRouter, adminCouponsRouter } from './catalog.js'

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128) })

const announcementSchema = z.object({
  enabled: z.boolean().optional(),
  message: z.string().trim().max(220).optional(),
  freeShippingEnabled: z.boolean().optional(),
  freeShippingThreshold: z.number().nonnegative().optional(),
  dismissible: z.boolean().optional(),
  ctaText: z.string().trim().max(80).optional(),
  ctaUrl: z.union([safeLinkSchema, z.literal('')]).optional(),
}).strict()

const storeSettingsSchema = z.object({
  shippingFee: z.number().nonnegative().max(100_000),
  freeShippingThreshold: z.number().nonnegative().max(10_000_000),
  codEnabled: z.boolean(),
  codMaxOrderValue: z.number().nonnegative().max(10_000_000).nullable(),
  maxQuantityPerItem: z.number().int().min(1).max(99),
}).partial().strict()

const dashboardQuerySchema = z.object({
  from: z.coerce.date().default(new Date(0)),
  to: z.coerce.date().optional(),
  lowStockThreshold: z.coerce.number().int().nonnegative().max(1000).default(5),
})

export const adminRouter = Router()

/**
 * Admin-only sign-in kept for the existing admin UI. It shares credential checks with `/auth/login`
 * and rejects non-admin accounts with the same generic error, so it reveals nothing extra.
 */
adminRouter.post('/login', authLimiter, asyncHandler(async (request, response) => {
  const input = loginSchema.parse(request.body)
  const user = await verifyCredentials(input.email, input.password)
  if (!user || user.status !== 'ACTIVE' || !['ADMIN', 'SUPER_ADMIN'].includes(user.role)) {
    throw new ApiError(401, 'Invalid admin credentials', [], 'INVALID_CREDENTIALS')
  }
  const session = await issueSession(response, user)
  await User.updateOne({ _id: user.id }, { lastLoginAt: new Date() })
  sendSuccess(response, session, 'Admin signed in')
}))

adminRouter.post('/logout', asyncHandler(async (request, response) => {
  await endSession(request, response)
  sendSuccess(response, null, 'Admin signed out')
}))

// Everything below requires an authenticated administrator.
adminRouter.use(authenticate, requireAdmin)

adminRouter.get('/me', asyncHandler(async (request, response) => {
  const user = await User.findById(request.auth!.sub).lean()
  if (!user) throw new ApiError(404, 'Admin account not found')
  sendSuccess(response, toPublicUser(user))
}))

/** All figures are computed from stored orders, users and products. */
adminRouter.get('/dashboard', asyncHandler(async (request, response) => {
  const { from, to = new Date(), lowStockThreshold } = dashboardQuerySchema.parse(request.query)
  if (from > to) throw new ApiError(400, 'Invalid dashboard date range')
  const dateMatch = { createdAt: { $gte: from, $lte: to } }
  const [sales, totalOrders, totalCustomers, newCustomers, pendingOrders, totalProducts, outOfStockProducts, lowStockProducts, revenueSeries, topProducts, ordersByStatus] = await Promise.all([
    Order.aggregate<{ total: number; count: number }>([
      { $match: { ...dateMatch, paymentStatus: 'PAID' } },
      { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } },
    ]),
    Order.countDocuments(dateMatch),
    User.countDocuments({ status: 'ACTIVE', role: 'CUSTOMER' }),
    User.countDocuments({ role: 'CUSTOMER', ...dateMatch }),
    Order.countDocuments({ ...dateMatch, status: { $in: ['PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING'] } }),
    Product.countDocuments({ status: { $ne: 'ARCHIVED' } }),
    Product.countDocuments({ status: { $ne: 'ARCHIVED' }, stock: 0 }),
    Product.countDocuments({ status: { $ne: 'ARCHIVED' }, stock: { $gt: 0, $lte: lowStockThreshold } }),
    Order.aggregate([
      { $match: { ...dateMatch, paymentStatus: 'PAID' } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } }, value: { $sum: '$total' } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, label: '$_id', value: 1 } },
    ]),
    Order.aggregate([
      { $match: { ...dateMatch, status: { $ne: 'CANCELLED' } } },
      { $unwind: '$items' },
      { $group: { _id: '$items.productId', name: { $last: '$items.productName' }, units: { $sum: '$items.quantity' }, revenue: { $sum: '$items.lineTotal' } } },
      { $sort: { units: -1, _id: 1 } },
      { $limit: 5 },
      { $project: { _id: 0, productId: '$_id', name: 1, units: 1, revenue: 1 } },
    ]),
    Order.aggregate([{ $match: dateMatch }, { $group: { _id: '$status', count: { $sum: 1 } } }, { $project: { _id: 0, status: '$_id', count: 1 } }]),
  ])

  const totalSales = sales[0]?.total ?? 0
  const paidOrders = sales[0]?.count ?? 0
  sendSuccess(response, {
    totalSales,
    totalOrders,
    paidOrders,
    totalCustomers,
    newCustomers,
    pendingOrders,
    totalProducts,
    outOfStockProducts,
    lowStockProducts,
    // Average over paid orders, since only paid orders contribute to sales.
    averageOrderValue: paidOrders ? Math.round((totalSales / paidOrders) * 100) / 100 : 0,
    revenueSeries,
    topProducts,
    ordersByStatus,
  })
}))

adminRouter.get('/settings/announcement', asyncHandler(async (_request, response) => {
  sendSuccess(response, await Announcement.findOne().lean())
}))

adminRouter.put('/settings/announcement', asyncHandler(async (request, response) => {
  const input = announcementSchema.parse(request.body)
  const next = await Announcement.findOneAndUpdate({}, { $set: input }, { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true })
  sendSuccess(response, next, 'Announcement updated')
}))

adminRouter.get('/settings/store', asyncHandler(async (_request, response) => {
  sendSuccess(response, await getStoreSettings())
}))

adminRouter.put('/settings/store', asyncHandler(async (request, response) => {
  const input = storeSettingsSchema.parse(request.body)
  const { codMaxOrderValue, ...rest } = input
  const update = codMaxOrderValue === null ? { $set: rest, $unset: { codMaxOrderValue: 1 } } : { $set: { ...rest, ...(codMaxOrderValue !== undefined ? { codMaxOrderValue } : {}) } }
  const next = await StoreSettings.findOneAndUpdate({}, update, { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true })
  sendSuccess(response, next, 'Store settings updated')
}))

/** Signed parameters for uploading large media directly from the browser to Cloudinary. */
adminRouter.post('/media/signature', asyncHandler(async (request, response) => {
  const input = z.object({ folder: z.enum(['products', 'hero']), resourceType: z.enum(['image', 'video']) }).parse(request.body)
  sendSuccess(response, createSignedUpload(mediaFolders[input.folder], input.resourceType))
}))

adminRouter.use('/products', adminProductsRouter)
adminRouter.use('/cms/hero', adminHeroRouter)
adminRouter.use('/orders', adminOrdersRouter)
adminRouter.use('/customers', adminCustomersRouter)
adminRouter.use('/categories', adminCategoriesRouter)
adminRouter.use('/coupons', adminCouponsRouter)
