import { Router } from 'express'
import { z } from 'zod'
import { Product } from '../models/Product.js'
import { Category } from '../models/Category.js'
import { Order } from '../models/Order.js'
import { asyncHandler } from '../utils/async-handler.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'
import { escapeRegex, paginate, slugSchema } from '../utils/validation.js'
import { publicStatusFilter, toPublicProduct } from '../services/catalog.service.js'

const sortOptions = {
  featured: { featured: -1, rating: -1, _id: 1 },
  price_low_high: { price: 1, _id: 1 },
  price_high_low: { price: -1, _id: 1 },
  rating: { rating: -1, reviews: -1, _id: 1 },
  newest: { createdAt: -1, _id: 1 },
} as const

const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(100).optional(),
  collection: z.string().trim().max(100).optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  featured: z.enum(['true', 'false']).optional(),
  inStock: z.enum(['true', 'false']).optional(),
  sort: z.enum(['featured', 'price_low_high', 'price_high_low', 'rating', 'newest']).default('featured'),
  page: z.coerce.number().int().positive().max(10_000).default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})
const limitSchema = z.object({ limit: z.coerce.number().int().positive().max(24).default(8) })

/**
 * Case-insensitive substring match of a slug ("luxury-candles") against a name ("Luxury Candles"),
 * preserving the existing storefront behaviour. User input is escaped so it cannot inject regex syntax.
 */
const nameMatcher = (value: string) => new RegExp(escapeRegex(value.replaceAll('-', ' ')), 'i')

const searchFields = ['name', 'fragrance', 'collection', 'category', 'tags', 'sku'] as const

export const productsRouter = Router()

productsRouter.get('/', asyncHandler(async (request, response) => {
  const query = querySchema.parse(request.query)
  const filter: Record<string, unknown> = { ...publicStatusFilter }
  if (query.category) filter.category = nameMatcher(query.category)
  if (query.collection) filter.collection = nameMatcher(query.collection)
  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    filter.price = { ...(query.minPrice !== undefined ? { $gte: query.minPrice } : {}), ...(query.maxPrice !== undefined ? { $lte: query.maxPrice } : {}) }
  }
  if (query.featured) filter.featured = query.featured === 'true'
  if (query.inStock === 'true') { filter.stock = { $gt: 0 }; filter.status = 'ACTIVE' }
  if (query.q) {
    // Partial, case-insensitive match so live search finds "Amber" from "am". Every word must match some field.
    const words = query.q.split(/\s+/).filter(Boolean).slice(0, 6)
    filter.$and = words.map((word) => {
      const pattern = new RegExp(String.raw`(^|\W)` + escapeRegex(word), 'i')
      return { $or: searchFields.map((field) => ({ [field]: pattern })) }
    })
  }
  const [items, total] = await Promise.all([
    Product.find(filter).sort(sortOptions[query.sort]).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Product.countDocuments(filter),
  ])
  sendSuccess(response, { items: items.map(toPublicProduct), pagination: paginate(query.page, query.limit, total) })
}))

/** Active categories with the number of storefront products in each. */
productsRouter.get('/categories', asyncHandler(async (_request, response) => {
  const [categories, counts] = await Promise.all([
    Category.find({ active: true }).sort({ sortOrder: 1, name: 1 }).lean(),
    Product.aggregate<{ _id: string; count: number }>([{ $match: publicStatusFilter }, { $group: { _id: { $toLower: '$category' }, count: { $sum: 1 } } }]),
  ])
  const countByName = new Map(counts.map((entry) => [entry._id, entry.count]))
  sendSuccess(response, categories.map((category) => ({ ...category, count: countByName.get(category.name.toLowerCase()) ?? 0 })))
}))

/** Best sellers ranked by units sold in non-cancelled orders. */
productsRouter.get('/best-sellers', asyncHandler(async (request, response) => {
  const { limit } = limitSchema.parse(request.query)
  const ranking = await Order.aggregate<{ _id: unknown; units: number }>([
    { $match: { status: { $ne: 'CANCELLED' } } },
    { $unwind: '$items' },
    { $group: { _id: '$items.productId', units: { $sum: '$items.quantity' } } },
    { $sort: { units: -1, _id: 1 } },
    { $limit: limit * 3 },
  ])
  const products = await Product.find({ _id: { $in: ranking.map((entry) => entry._id) }, ...publicStatusFilter }).lean()
  const byId = new Map(products.map((product) => [String(product._id), product]))
  const items = ranking.flatMap((entry) => {
    const product = byId.get(String(entry._id))
    return product ? [{ ...toPublicProduct(product), unitsSold: entry.units }] : []
  }).slice(0, limit)
  sendSuccess(response, items)
}))

productsRouter.get('/featured', asyncHandler(async (request, response) => {
  const { limit } = limitSchema.parse(request.query)
  const items = await Product.find({ ...publicStatusFilter, featured: true }).sort(sortOptions.featured).limit(limit).lean()
  sendSuccess(response, items.map(toPublicProduct))
}))

productsRouter.get('/:slug', asyncHandler(async (request, response) => {
  const slug = slugSchema.parse(request.params.slug)
  const product = await Product.findOne({ slug, ...publicStatusFilter }).lean()
  if (!product) throw new ApiError(404, 'Product not found')
  sendSuccess(response, toPublicProduct(product))
}))

/** Related products: same collection or category first, then shared tags. */
productsRouter.get('/:slug/related', asyncHandler(async (request, response) => {
  const slug = slugSchema.parse(request.params.slug)
  const { limit } = limitSchema.parse(request.query)
  const product = await Product.findOne({ slug, ...publicStatusFilter }).select('category collection tags').lean()
  if (!product) throw new ApiError(404, 'Product not found')
  const items = await Product.aggregate([
    { $match: { ...publicStatusFilter, _id: { $ne: product._id }, $or: [{ collection: product.collection }, { category: product.category }, { tags: { $in: product.tags ?? [] } }] } },
    { $addFields: { relevance: { $add: [
      { $cond: [{ $eq: ['$collection', product.collection] }, 3, 0] },
      { $cond: [{ $eq: ['$category', product.category] }, 2, 0] },
      { $size: { $setIntersection: [{ $ifNull: ['$tags', []] }, product.tags ?? []] } },
    ] } } },
    { $sort: { relevance: -1, rating: -1, _id: 1 } },
    { $limit: limit },
    { $project: { relevance: 0 } },
  ])
  sendSuccess(response, items.map(toPublicProduct))
}))
