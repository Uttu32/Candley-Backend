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

const DAY_MS = 86_400_000
const IST_OFFSET_MS = 330 * 60_000
const istDayKey = (date: Date) => new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)

/** Every IST day (YYYY-MM-DD) or month (YYYY-MM) between two dates, so charts show quiet periods as zero. */
const periodKeys = (from: Date, to: Date, unit: 'day' | 'month') => {
  const keys: string[] = []
  const last = unit === 'day' ? istDayKey(to) : istDayKey(to).slice(0, 7)
  if (unit === 'day') {
    for (let time = from.getTime(); istDayKey(new Date(time)) <= last; time += DAY_MS) keys.push(istDayKey(new Date(time)))
    return keys
  }
  let [year, month] = istDayKey(from).split('-').map(Number)
  for (let key = `${year}-${String(month).padStart(2, '0')}`; key <= last; key = `${year}-${String(month).padStart(2, '0')}`) {
    keys.push(key)
    month += 1
    if (month > 12) { month = 1; year += 1 }
  }
  return keys
}

const average = (total: number, count: number) => (count ? Math.round((total / count) * 100) / 100 : 0)

/** Paid sales, booked (non-cancelled) value and order/customer counts for one window. */
const periodTotals = async (from: Date, to: Date) => {
  const dateMatch = { createdAt: { $gte: from, $lte: to } }
  const isPaid = { $eq: ['$paymentStatus', 'PAID'] }
  const isLive = { $ne: ['$status', 'CANCELLED'] }
  const [totals, newCustomers] = await Promise.all([
    Order.aggregate<{ totalSales: number; paidOrders: number; bookedSales: number; bookedOrders: number; totalOrders: number }>([
      { $match: dateMatch },
      { $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalSales: { $sum: { $cond: [isPaid, '$total', 0] } },
        paidOrders: { $sum: { $cond: [isPaid, 1, 0] } },
        bookedSales: { $sum: { $cond: [isLive, '$total', 0] } },
        bookedOrders: { $sum: { $cond: [isLive, 1, 0] } },
      } },
    ]),
    User.countDocuments({ role: 'CUSTOMER', ...dateMatch }),
  ])
  const row = totals[0] ?? { totalSales: 0, paidOrders: 0, bookedSales: 0, bookedOrders: 0, totalOrders: 0 }
  return {
    totalSales: row.totalSales,
    paidOrders: row.paidOrders,
    totalOrders: row.totalOrders,
    bookedSales: row.bookedSales,
    bookedOrders: row.bookedOrders,
    newCustomers,
    // Average over paid orders, since only paid orders contribute to sales.
    averageOrderValue: average(row.totalSales, row.paidOrders),
    bookedAverageOrderValue: average(row.bookedSales, row.bookedOrders),
  }
}

/** All figures are computed from stored orders, users and products. */
adminRouter.get('/dashboard', asyncHandler(async (request, response) => {
  const { from, to = new Date(), lowStockThreshold } = dashboardQuerySchema.parse(request.query)
  if (from > to) throw new ApiError(400, 'Invalid dashboard date range')
  const hasRange = request.query.from !== undefined
  const span = to.getTime() - from.getTime()
  // Short ranges chart by day; long ranges and "all time" chart by month.
  const unit: 'day' | 'month' = hasRange && span <= 120 * DAY_MS ? 'day' : 'month'
  const dateMatch = { createdAt: { $gte: from, $lte: to } }
  const liveProducts = { status: { $ne: 'ARCHIVED' as const } }

  const [current, previous, totalCustomers, pendingOrders, totalProducts, outOfStockProducts, lowStockProducts, series, topProducts, ordersByStatus, paymentMethods, recentOrders, lowStockItems, attention] = await Promise.all([
    periodTotals(from, to),
    // The equally long window just before this one, for trend comparisons.
    hasRange ? periodTotals(new Date(from.getTime() - span), new Date(from.getTime() - 1)) : Promise.resolve(null),
    User.countDocuments({ status: 'ACTIVE', role: 'CUSTOMER' }),
    Order.countDocuments({ ...dateMatch, status: { $in: ['PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING'] } }),
    Product.countDocuments(liveProducts),
    Product.countDocuments({ ...liveProducts, stock: 0 }),
    Product.countDocuments({ ...liveProducts, stock: { $gt: 0, $lte: lowStockThreshold } }),
    Order.aggregate<{ label: string; value: number; booked: number; orders: number }>([
      { $match: { ...dateMatch, status: { $ne: 'CANCELLED' } } },
      { $group: {
        _id: { $dateToString: { format: unit === 'day' ? '%Y-%m-%d' : '%Y-%m', date: '$createdAt', timezone: 'Asia/Kolkata' } },
        value: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'PAID'] }, '$total', 0] } },
        booked: { $sum: '$total' },
        orders: { $sum: 1 },
      } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, label: '$_id', value: 1, booked: 1, orders: 1 } },
    ]),
    Order.aggregate([
      { $match: { ...dateMatch, status: { $ne: 'CANCELLED' } } },
      { $unwind: '$items' },
      { $group: {
        _id: '$items.productId',
        name: { $last: '$items.productName' },
        image: { $last: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$items.thumbnailImage', ''] } }, 0] }, '$items.thumbnailImage', '$items.image'] } },
        units: { $sum: '$items.quantity' },
        revenue: { $sum: '$items.lineTotal' },
      } },
      { $sort: { units: -1, _id: 1 } },
      { $limit: 5 },
      { $project: { _id: 0, productId: '$_id', name: 1, image: 1, units: 1, revenue: 1 } },
    ]),
    Order.aggregate([{ $match: dateMatch }, { $group: { _id: '$status', count: { $sum: 1 } } }, { $project: { _id: 0, status: '$_id', count: 1 } }]),
    Order.aggregate([
      { $match: { ...dateMatch, status: { $ne: 'CANCELLED' } } },
      { $group: { _id: '$paymentMethod', count: { $sum: 1 }, amount: { $sum: '$total' } } },
      { $sort: { amount: -1 } },
      { $project: { _id: 0, method: '$_id', count: 1, amount: 1 } },
    ]),
    Order.find().sort({ createdAt: -1, _id: -1 }).limit(6)
      .select('orderNumber shippingAddress.name total status paymentStatus paymentMethod createdAt items.quantity').lean(),
    Product.find({ ...liveProducts, stock: { $lte: lowStockThreshold } }).sort({ stock: 1, name: 1 }).limit(6)
      .select('name sku stock thumbnailImage images').lean(),
    // Current workload, independent of the selected period.
    Order.aggregate<{ awaitingPayment: number; toProcess: number; toShip: number; codToCollect: number }>([
      { $match: { status: { $in: ['PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING', 'DELIVERED'] } } },
      { $group: {
        _id: null,
        awaitingPayment: { $sum: { $cond: [{ $eq: ['$status', 'PENDING_PAYMENT'] }, 1, 0] } },
        toProcess: { $sum: { $cond: [{ $eq: ['$status', 'CONFIRMED'] }, 1, 0] } },
        toShip: { $sum: { $cond: [{ $eq: ['$status', 'PROCESSING'] }, 1, 0] } },
        codToCollect: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'DELIVERED'] }, { $eq: ['$paymentMethod', 'COD'] }, { $ne: ['$paymentStatus', 'PAID'] }] }, 1, 0] } },
      } },
      { $project: { _id: 0 } },
    ]),
  ])

  // Without a range, the chart starts at the first order rather than at 1970.
  const firstLabel = series[0]?.label
  const seriesStart = hasRange ? from : firstLabel ? new Date(`${firstLabel.length === 7 ? `${firstLabel}-01` : firstLabel}T00:00:00+05:30`) : null
  const byLabel = new Map(series.map((point) => [point.label, point]))
  const revenueSeries = seriesStart ? periodKeys(seriesStart, to, unit).map((label) => byLabel.get(label) ?? { label, value: 0, booked: 0, orders: 0 }) : []

  sendSuccess(response, {
    ...current,
    totalCustomers,
    pendingOrders,
    totalProducts,
    outOfStockProducts,
    lowStockProducts,
    lowStockThreshold,
    previous,
    seriesUnit: unit,
    revenueSeries,
    topProducts,
    ordersByStatus,
    paymentMethods,
    needsAttention: attention[0] ?? { awaitingPayment: 0, toProcess: 0, toShip: 0, codToCollect: 0 },
    recentOrders: recentOrders.map((order) => ({
      _id: order._id,
      orderNumber: order.orderNumber,
      customerName: order.shippingAddress?.name ?? '',
      itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
      total: order.total,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      createdAt: order.createdAt,
    })),
    lowStockItems: lowStockItems.map((product) => ({
      _id: product._id,
      name: product.name,
      sku: product.sku,
      stock: product.stock,
      image: product.thumbnailImage || product.images?.[0] || '',
    })),
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
