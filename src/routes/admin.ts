import { Router } from 'express'
import { z } from 'zod'
import argon2 from 'argon2'
import { randomUUID } from 'node:crypto'
import { User } from '../models/User.js'
import { RefreshToken } from '../models/RefreshToken.js'
import { Announcement } from '../models/Announcement.js'
import { HeroSlide } from '../models/HeroSlide.js'
import { Order } from '../models/Order.js'
import { Product } from '../models/Product.js'
import { User as UserModel } from '../models/User.js'
import { authenticate, requireRole } from '../middlewares/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/tokens.js'
import multer from 'multer'
import { uploadImage } from '../config/cloudinary.js'

const refreshCookie = 'candley_refresh_token'
const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid identifier')
const adminProductsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().max(100).optional(),
})

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

const productSchema = z.object({
  name: z.string().min(2).max(160),
  slug: z.string().min(2).max(180).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  sku: z.string().min(2).max(80),
  category: z.string().min(1).max(100),
  collection: z.string().min(1).max(100),
  fragrance: z.string().min(1).max(100),
  description: z.string().min(2),
  shortDescription: z.string().min(2).max(240),
  price: z.coerce.number().nonnegative(),
  mrp: z.coerce.number().nonnegative(),
  stock: z.coerce.number().int().nonnegative(),
  tags: z.array(z.string()).default([]),
  status: z.enum(['DRAFT', 'ACTIVE', 'OUT_OF_STOCK', 'ARCHIVED']).default('ACTIVE'),
  featured: z.boolean().default(false),
  variants: z.array(z.object({ label: z.string().min(1), sku: z.string().min(1), price: z.coerce.number().nonnegative(), stock: z.coerce.number().int().nonnegative() })).default([]),
}).refine((value) => value.mrp >= value.price, { message: 'MRP must be greater than or equal to price', path: ['mrp'] })

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 12, fileSize: 8 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(file.mimetype)),
})

export const adminRouter = Router()

const getProductPayload = (body: Record<string, unknown>) => {
  const raw = typeof body.product === 'string' ? JSON.parse(body.product) : body
  return productSchema.parse({ ...raw, tags: typeof raw.tags === 'string' ? JSON.parse(raw.tags) : raw.tags, variants: typeof raw.variants === 'string' ? JSON.parse(raw.variants) : raw.variants })
}

adminRouter.post('/login', asyncHandler(async (request, response) => {
  const input = adminLoginSchema.parse(request.body)
  const user = await User.findOne({ email: input.email.toLowerCase() }).select('+passwordHash')
  if (!user || !(await argon2.verify(user.passwordHash, input.password))) {
    throw new ApiError(401, 'Invalid admin credentials')
  }
  if (user.status !== 'ACTIVE') throw new ApiError(403, 'Admin account is not active')
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

adminRouter.get('/dashboard', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), asyncHandler(async (request, response) => {
  const from = typeof request.query.from === 'string' ? new Date(request.query.from) : new Date(0)
  const to = typeof request.query.to === 'string' ? new Date(request.query.to) : new Date()
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new ApiError(400, 'Invalid dashboard date range')
  }

  const dateMatch = { createdAt: { $gte: from, $lte: to } }
  const [sales, totalOrders, totalCustomers, pendingOrders, totalProducts, outOfStockProducts, revenueSeries] = await Promise.all([
    Order.aggregate([
      { $match: { ...dateMatch, paymentStatus: 'PAID' } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]),
    Order.countDocuments(dateMatch),
    UserModel.countDocuments({ status: 'ACTIVE' }),
    Order.countDocuments({ ...dateMatch, status: { $in: ['PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING'] } }),
    Product.countDocuments({ status: { $ne: 'ARCHIVED' } }),
    Product.countDocuments({ status: { $ne: 'ARCHIVED' }, stock: 0 }),
    Order.aggregate([
      { $match: { ...dateMatch, paymentStatus: 'PAID' } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, value: { $sum: '$total' } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, label: '$_id', value: 1 } },
    ]),
  ])

  const totalSales = sales[0]?.total ?? 0
  sendSuccess(response, {
    totalSales,
    totalOrders,
    totalCustomers,
    pendingOrders,
    totalProducts,
    outOfStockProducts,
    averageOrderValue: totalOrders ? totalSales / totalOrders : 0,
    revenueSeries,
  })
}))

adminRouter.get('/products', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), asyncHandler(async (request, response) => {
  const { page, limit, search = '' } = adminProductsQuerySchema.parse(request.query)
  const filter = search ? { $or: [{ name: new RegExp(search, 'i') }, { sku: new RegExp(search, 'i') }, { slug: new RegExp(search, 'i') }] } : {}
  const [items, total] = await Promise.all([
    Product.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Product.countDocuments(filter),
  ])
  sendSuccess(response, { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } })
}))

adminRouter.post('/products', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), imageUpload.array('images', 12), asyncHandler(async (request, response) => {
  console.log("I am inside the post products route")
  const input = getProductPayload(request.body as Record<string, unknown>)
  const files = (request.files as Express.Multer.File[] | undefined) ?? []
  const uploaded = await Promise.all(files.map((file) => uploadImage(file.buffer, 'candley-aroma/products')))
  const thumbnailIndex = Math.max(Number(request.body.thumbnailIndex) || 0, 0)
  const images = uploaded.map((image) => image.secure_url)
  let product: any = null
  try {
    product = await Product.create({ ...input, images, thumbnailImage: images[thumbnailIndex] ?? images[0] ?? '' })
    
  } catch (error) {
    console.log(error, 'this is error')
  }
  console.log(product, 'this is product')
  sendSuccess(response, product, 'Product created', 201)
}))

adminRouter.patch('/products/:id', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), imageUpload.array('images', 12), asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const input = getProductPayload(request.body as Record<string, unknown>)
  const current = await Product.findById(id)
  if (!current) throw new ApiError(404, 'Product not found')
  const files = (request.files as Express.Multer.File[] | undefined) ?? []
  const uploaded = await Promise.all(files.map((file) => uploadImage(file.buffer, 'candley-aroma/products')))
  const newImages = uploaded.map((image) => image.secure_url)
  const images = newImages.length ? [...current.images, ...newImages] : current.images
  const thumbnailIndex = Math.max(Number(request.body.thumbnailIndex) || 0, 0)
  const product = await Product.findByIdAndUpdate(id, { $set: { ...input, images, thumbnailImage: images[thumbnailIndex] ?? current.thumbnailImage ?? images[0] ?? '' } }, { new: true, runValidators: true })
  sendSuccess(response, product, 'Product updated')
}))

adminRouter.post('/cms/hero/:id/image', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), imageUpload.single('image'), asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const target = z.enum(['desktopImage', 'mobileImage']).parse(request.body.target ?? 'desktopImage')
  const file = request.file
  if (!file) throw new ApiError(422, 'An image is required')
  const uploaded = await uploadImage(file.buffer, 'candley-aroma/hero')
  const slide = await HeroSlide.findByIdAndUpdate(id, { $set: { [target]: uploaded.secure_url } }, { new: true, runValidators: true })
  if (!slide) throw new ApiError(404, 'Hero slide not found')
  sendSuccess(response, slide, 'Hero image updated')
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
  const id = objectIdSchema.parse(request.params.id)
  const payload = heroSlideSchema.partial().parse(request.body)
  const slide = await HeroSlide.findByIdAndUpdate(id, { $set: payload }, { new: true })
  if (!slide) throw new ApiError(404, 'Hero slide not found')
  sendSuccess(response, slide, 'Hero slide updated')
}))

adminRouter.delete('/cms/hero/:id', authenticate, requireRole('ADMIN', 'SUPER_ADMIN'), asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const slide = await HeroSlide.findByIdAndDelete(id)
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
