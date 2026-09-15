import { Router } from 'express'
import { z } from 'zod'
import { Cart } from '../models/Cart.js'
import { Product } from '../models/Product.js'
import { authenticate } from '../middlewares/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'

const itemSchema = z.object({ productId: z.string().min(1), variantId: z.string().optional(), quantity: z.number().int().positive().max(99) })
export const cartRouter = Router()
cartRouter.use(authenticate)
cartRouter.get('/', asyncHandler(async (request, response) => sendSuccess(response, await Cart.findOne({ userId: request.auth!.sub }).populate('items.productId').lean() ?? { userId: request.auth!.sub, items: [] })))
cartRouter.post('/items', asyncHandler(async (request, response) => {
  const input = itemSchema.parse(request.body)
  const product = await Product.findOne({ _id: input.productId, status: 'ACTIVE' })
  if (!product) throw new ApiError(404, 'Product not found')
  if (product.stock < input.quantity) throw new ApiError(409, 'Insufficient stock')
  const cart = await Cart.findOneAndUpdate({ userId: request.auth!.sub }, { $setOnInsert: { userId: request.auth!.sub }, $push: { items: input } }, { new: true, upsert: true }).populate('items.productId')
  sendSuccess(response, cart, 'Item added')
}))
cartRouter.patch('/items/:productId', asyncHandler(async (request, response) => {
  const quantity = z.object({ quantity: z.number().int().nonnegative().max(99) }).parse(request.body).quantity
  const cart = await Cart.findOne({ userId: request.auth!.sub })
  if (!cart) throw new ApiError(404, 'Cart not found')
  const item = cart.items.find((entry) => entry.productId.toString() === request.params.productId)
  if (!item) throw new ApiError(404, 'Cart item not found')
  if (quantity === 0) cart.items.pull(item._id)
  else item.quantity = quantity
  await cart.save()
  sendSuccess(response, cart)
}))
cartRouter.delete('/items/:productId', asyncHandler(async (request, response) => sendSuccess(response, await Cart.findOneAndUpdate({ userId: request.auth!.sub }, { $pull: { items: { productId: request.params.productId } } }, { new: true }).lean())))
