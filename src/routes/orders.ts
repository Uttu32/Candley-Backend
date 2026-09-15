import { randomInt } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../middlewares/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'
import { Cart } from '../models/Cart.js'
import { Order } from '../models/Order.js'

const addressSchema = z.object({ name: z.string().min(2), phone: z.string().min(8), addressLine1: z.string().min(3), city: z.string().min(2), state: z.string().min(2), postalCode: z.string().min(4), country: z.string().default('India') })
const checkoutSchema = z.object({ shippingAddress: addressSchema, paymentMethod: z.enum(['RAZORPAY', 'COD']) })
export const ordersRouter = Router()
ordersRouter.use(authenticate)
ordersRouter.get('/', asyncHandler(async (request, response) => sendSuccess(response, await Order.find({ userId: request.auth!.sub }).sort({ createdAt: -1 }).lean())))
ordersRouter.get('/:id', asyncHandler(async (request, response) => { const order = await Order.findOne({ _id: request.params.id, userId: request.auth!.sub }).lean(); if (!order) throw new ApiError(404, 'Order not found'); sendSuccess(response, order) }))
ordersRouter.post('/', asyncHandler(async (request, response) => {
  const input = checkoutSchema.parse(request.body)
  const cart = await Cart.findOne({ userId: request.auth!.sub }).populate('items.productId')
  if (!cart?.items.length) throw new ApiError(422, 'Cart is empty')
  const items = cart.items.map((item) => { const product = item.productId as unknown as { _id: string; name: string; sku: string; price: number; images: string[]; stock: number }; if (product.stock < item.quantity) throw new ApiError(409, `Insufficient stock for ${product.name}`); return { productId: product._id, productName: product.name, sku: product.sku, image: product.images[0], unitPrice: product.price, quantity: item.quantity, lineTotal: product.price * item.quantity } })
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0)
  const order = await Order.create({ orderNumber: `CAN-${new Date().getFullYear()}-${randomInt(100000, 999999)}`, userId: request.auth!.sub, items, shippingAddress: input.shippingAddress, subtotal, shipping: subtotal >= 999 ? 0 : 99, tax: 0, total: subtotal + (subtotal >= 999 ? 0 : 99), paymentMethod: input.paymentMethod, status: input.paymentMethod === 'COD' ? 'CONFIRMED' : 'PENDING_PAYMENT' })
  if (input.paymentMethod === 'COD') await Cart.updateOne({ userId: request.auth!.sub }, { $set: { items: [] } })
  sendSuccess(response, order, 'Checkout order created', 201)
}))
