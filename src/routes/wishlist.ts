import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../middlewares/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'
import { objectIdSchema } from '../utils/validation.js'
import { Wishlist } from '../models/Wishlist.js'
import { Product } from '../models/Product.js'
import { publicStatusFilter, toPublicProduct } from '../services/catalog.service.js'

const maxWishlistItems = 200

export const wishlistRouter = Router()
wishlistRouter.use(authenticate)

/**
 * Response contract: `{ productIds: Product[] }`. Archived/draft or deleted products are omitted
 * from the response; they remain stored so they reappear if republished.
 */
const wishlistView = async (userId: string) => {
  const wishlist = await Wishlist.findOne({ userId }).lean()
  const ids = wishlist?.productIds ?? []
  const products = ids.length ? await Product.find({ _id: { $in: ids }, ...publicStatusFilter }).lean() : []
  const byId = new Map(products.map((product) => [String(product._id), product]))
  return {
    userId,
    productIds: ids.map((id) => byId.get(String(id))).filter((product) => product !== undefined).map(toPublicProduct),
  }
}

wishlistRouter.get('/', asyncHandler(async (request, response) => {
  sendSuccess(response, await wishlistView(request.auth!.sub))
}))

wishlistRouter.post('/', asyncHandler(async (request, response) => {
  const { productId } = z.object({ productId: objectIdSchema }).parse(request.body)
  if (!(await Product.exists({ _id: productId, ...publicStatusFilter }))) throw new ApiError(404, 'Product not found')
  const result = await Wishlist.updateOne(
    { userId: request.auth!.sub, $expr: { $lt: [{ $size: { $ifNull: ['$productIds', []] } }, maxWishlistItems] } },
    { $addToSet: { productIds: productId } },
  )
  if (result.matchedCount === 0) {
    // Either there is no wishlist yet, or it is full.
    const exists = await Wishlist.exists({ userId: request.auth!.sub })
    if (exists) throw new ApiError(422, `Your wishlist can hold up to ${maxWishlistItems} products`)
    await Wishlist.updateOne({ userId: request.auth!.sub }, { $setOnInsert: { userId: request.auth!.sub }, $addToSet: { productIds: productId } }, { upsert: true })
  }
  sendSuccess(response, await wishlistView(request.auth!.sub), 'Added to wishlist')
}))

wishlistRouter.delete('/:productId', asyncHandler(async (request, response) => {
  const productId = objectIdSchema.parse(request.params.productId)
  await Wishlist.updateOne({ userId: request.auth!.sub }, { $pull: { productIds: productId } })
  sendSuccess(response, await wishlistView(request.auth!.sub), 'Removed from wishlist')
}))

wishlistRouter.delete('/', asyncHandler(async (request, response) => {
  await Wishlist.updateOne({ userId: request.auth!.sub }, { $set: { productIds: [] } })
  sendSuccess(response, await wishlistView(request.auth!.sub), 'Wishlist cleared')
}))
