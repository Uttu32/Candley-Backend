import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../middlewares/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { sendSuccess } from '../utils/response.js'
import { objectIdSchema } from '../utils/validation.js'
import { addItem, clearCart, getCartView, removeItem, setItemQuantity } from '../services/cart.service.js'

const variantIdSchema = z.union([objectIdSchema, z.literal('default'), z.literal('')]).optional()
const addItemSchema = z.object({
  productId: objectIdSchema,
  variantId: variantIdSchema,
  quantity: z.number().int().positive().max(99).default(1),
})
const quantitySchema = z.object({ quantity: z.number().int().nonnegative().max(99), variantId: variantIdSchema })
const variantQuerySchema = z.object({ variantId: variantIdSchema })

export const cartRouter = Router()
cartRouter.use(authenticate)

cartRouter.get('/', asyncHandler(async (request, response) => {
  sendSuccess(response, await getCartView(request.auth!.sub))
}))

cartRouter.post('/items', asyncHandler(async (request, response) => {
  const input = addItemSchema.parse(request.body)
  sendSuccess(response, await addItem(request.auth!.sub, input.productId, input.variantId, input.quantity), 'Item added')
}))

/** `variantId` may be given in the body or query string; it is required only when the product has several lines. */
cartRouter.patch('/items/:productId', asyncHandler(async (request, response) => {
  const productId = objectIdSchema.parse(request.params.productId)
  const input = quantitySchema.parse(request.body)
  const variantId = input.variantId ?? variantQuerySchema.parse(request.query).variantId
  sendSuccess(response, await setItemQuantity(request.auth!.sub, productId, variantId, input.quantity), 'Cart updated')
}))

cartRouter.delete('/items/:productId', asyncHandler(async (request, response) => {
  const productId = objectIdSchema.parse(request.params.productId)
  const { variantId } = variantQuerySchema.parse(request.query)
  sendSuccess(response, await removeItem(request.auth!.sub, productId, variantId), 'Item removed')
}))

cartRouter.delete('/', asyncHandler(async (request, response) => {
  sendSuccess(response, await clearCart(request.auth!.sub), 'Cart cleared')
}))
