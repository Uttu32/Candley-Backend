import { Router } from 'express'
import { z } from 'zod'
import { Product } from '../models/Product.js'
import { Category } from '../models/Category.js'
import { asyncHandler } from '../utils/async-handler.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'

const querySchema = z.object({ q: z.string().optional(), category: z.string().optional(), collection: z.string().optional(), maxPrice: z.coerce.number().nonnegative().optional(), sort: z.enum(['featured', 'price_low_high', 'price_high_low', 'rating']).default('featured'), page: z.coerce.number().int().positive().default(1), limit: z.coerce.number().int().positive().max(100).default(20) })
const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid product slug')

export const productsRouter = Router()
productsRouter.get('/', asyncHandler(async (request, response) => {
  const query = querySchema.parse(request.query)
  const filter: Record<string, unknown> = { status: 'ACTIVE' }
  if (query.category) filter.category = new RegExp(query.category.replaceAll('-', ' '), 'i')
  if (query.collection) filter.collection = new RegExp(query.collection.replaceAll('-', ' '), 'i')
  if (query.maxPrice !== undefined) filter.price = { $lte: query.maxPrice }
  if (query.q) filter.$text = { $search: query.q }
  const sort: Record<string, 1 | -1> = query.sort === 'price_low_high' ? { price: 1 } : query.sort === 'price_high_low' ? { price: -1 } : query.sort === 'rating' ? { rating: -1 } : { featured: -1, rating: -1 }
  const [items, total] = await Promise.all([Product.find(filter).sort(sort).skip((query.page - 1) * query.limit).limit(query.limit).lean(), Product.countDocuments(filter)])
  sendSuccess(response, { items, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } })
}))
productsRouter.get('/categories', asyncHandler(async (_request, response) => sendSuccess(response, await Category.find({ active: true }).sort({ sortOrder: 1 }).lean())))
productsRouter.get('/:slug', asyncHandler(async (request, response) => {
  const slug = slugSchema.parse(request.params.slug)
  const product = await Product.findOne({ slug, status: 'ACTIVE' }).lean()
  if (!product) throw new ApiError(404, 'Product not found')
  sendSuccess(response, product)
}))
