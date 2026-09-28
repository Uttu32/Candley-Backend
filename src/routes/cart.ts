import { Router } from 'express'
import { z } from 'zod'
import { Cart } from '../models/Cart.js'
import { Product } from '../models/Product.js'
import { authenticate } from '../middlewares/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'

const itemSchema = z.object({ productId: z.string().min(1), variantId: z.string().optional(), quantity: z.number().int().positive().max(99) })
const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid product identifier')
export const cartRouter = Router()
cartRouter.use(authenticate)

cartRouter.get(
  '/',
  asyncHandler(async (request, response) => {
    const cart =
      await Cart.findOne({ userId: request.auth!.sub })
        .populate('items.productId')
        .lean();

    if (!cart) {
      return sendSuccess(response, {
        userId: request.auth!.sub,
        items: [],
      });
    }

    const groupedItems = Object.values(
      cart.items.reduce((acc, item) => {
        const productId: any = item.productId?._id?.toString();

        if (!productId) return acc;

        if (!acc[productId]) {
          acc[productId] = {
            ...item,
            quantity: item.quantity,
          };
        } else {
          acc[productId].quantity += item.quantity;
        }

        return acc;
      }, {} as Record<string, (typeof cart.items)[number]>)
    );

    return sendSuccess(response, {
      ...cart,
      items: groupedItems,
    });
  })
);

cartRouter.post('/items', asyncHandler(async (request, response) => {
  const input = itemSchema.parse(request.body)
  const productId = objectIdSchema.parse(input.productId)
  const product = await Product.findOne({ _id: productId, status: 'ACTIVE' })
  if (!product) throw new ApiError(404, 'Product not found')
  if (product.stock < input.quantity) throw new ApiError(409, 'Insufficient stock')
  const cart = await Cart.findOneAndUpdate({ userId: request.auth!.sub }, { $setOnInsert: { userId: request.auth!.sub }, $push: { items: input } }, { new: true, upsert: true }).populate('items.productId')
  sendSuccess(response, cart, 'Item added')
}))
cartRouter.patch('/items/:productId', asyncHandler(async (request, response) => {
  const productId = objectIdSchema.parse(request.params.productId)
  const quantity = z.object({ quantity: z.number().int().nonnegative().max(99) }).parse(request.body).quantity
  const cart = await Cart.findOne({ userId: request.auth!.sub })
  if (!cart) throw new ApiError(404, 'Cart not found')
  const item = cart.items.find((entry) => entry.productId.toString() === productId)
  if (!item) throw new ApiError(404, 'Cart item not found')
  if (quantity === 0) cart.items.pull(item._id)
  else item.quantity = quantity
  await cart.save()
  sendSuccess(response, cart)
}))
cartRouter.delete('/items/:productId', asyncHandler(async (request, response) => {
  const productId = objectIdSchema.parse(request.params.productId)
  sendSuccess(response, await Cart.findOneAndUpdate({ userId: request.auth!.sub }, { $pull: { items: { productId } } }, { new: true }).lean())
}))
