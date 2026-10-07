import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../middlewares/auth.js'
import { checkoutLimiter } from '../middlewares/rate-limit.js'
import { asyncHandler } from '../utils/async-handler.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'
import { objectIdSchema, paginate, paginationSchema } from '../utils/validation.js'
import { Order } from '../models/Order.js'
import { addressInputSchema } from './account.js'
import { cancelOrder, createOrder, markOrderPaid, quoteOrder, startRazorpayPayment } from '../services/order.service.js'
import { verifyPaymentSignature } from '../services/razorpay.service.js'

const shippingAddressSchema = addressInputSchema.omit({ label: true, isDefault: true })
const checkoutSchema = z.object({
  shippingAddress: shippingAddressSchema.optional(),
  addressId: objectIdSchema.optional(),
  paymentMethod: z.enum(['RAZORPAY', 'COD']),
  couponCode: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/, 'Invalid coupon code').optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
}).refine((value) => value.shippingAddress || value.addressId, { message: 'shippingAddress or addressId is required', path: ['shippingAddress'] })
const verifySchema = z.object({
  razorpay_order_id: z.string().min(1).max(100),
  razorpay_payment_id: z.string().min(1).max(100),
  razorpay_signature: z.string().regex(/^[a-f\d]{64}$/i, 'Invalid signature'),
})
const cancelSchema = z.object({ reason: z.string().trim().max(300).optional() })
const listQuerySchema = paginationSchema.extend({ limit: z.coerce.number().int().positive().max(50).default(50) })

/** Fields customers see. Internal bookkeeping (fingerprint, idempotency key, coupon id) is not exposed. */
const customerProjection = '-checkoutFingerprint -idempotencyKey -couponId -inventoryReleased -statusHistory.changedBy'

export const ordersRouter = Router()
ordersRouter.use(authenticate)

/** Response stays an array (existing contract); pagination is exposed through headers. */
ordersRouter.get('/', asyncHandler(async (request, response) => {
  const { page, limit } = listQuerySchema.parse(request.query)
  const filter = { userId: request.auth!.sub }
  const [orders, total] = await Promise.all([
    Order.find(filter).select(customerProjection).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
  ])
  const pagination = paginate(page, limit, total)
  response.setHeader('X-Total-Count', String(total))
  response.setHeader('X-Total-Pages', String(pagination.totalPages))
  sendSuccess(response, orders)
}))

/** Server-calculated totals for the current cart (and optional coupon) without creating an order. */
ordersRouter.post('/quote', asyncHandler(async (request, response) => {
  const { couponCode } = z.object({ couponCode: z.string().trim().max(40).regex(/^[A-Za-z0-9_-]*$/, 'Invalid coupon code').optional() }).parse(request.body ?? {})
  sendSuccess(response, await quoteOrder(request.auth!.sub, couponCode || undefined))
}))

ordersRouter.get('/:id', asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const order = await Order.findOne({ _id: id, userId: request.auth!.sub }).select(customerProjection).lean()
  if (!order) throw new ApiError(404, 'Order not found')
  sendSuccess(response, order)
}))

ordersRouter.post('/', checkoutLimiter, asyncHandler(async (request, response) => {
  const input = checkoutSchema.parse(request.body)
  const headerKey = request.get('Idempotency-Key')
  const idempotencyKey = input.idempotencyKey ?? (headerKey ? z.string().trim().min(8).max(100).parse(headerKey) : undefined)
  const { order, created } = await createOrder({ ...input, idempotencyKey, userId: request.auth!.sub })
  const { checkoutFingerprint: _f, idempotencyKey: _k, couponId: _c, inventoryReleased: _r, ...publicOrder } = order
  sendSuccess(response, publicOrder, created ? 'Checkout order created' : 'Existing order returned', created ? 201 : 200)
}))

ordersRouter.post('/:id/cancel', asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const { reason } = cancelSchema.parse(request.body ?? {})
  await cancelOrder(id, { kind: 'customer', userId: request.auth!.sub }, reason ?? 'Cancelled by customer')
  sendSuccess(response, await Order.findById(id).select(customerProjection).lean(), 'Order cancelled')
}))

/** Returns the parameters the storefront needs to open Razorpay Checkout for this order. */
ordersRouter.post('/:id/payment/razorpay', checkoutLimiter, asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  sendSuccess(response, await startRazorpayPayment(request.auth!.sub, id), 'Payment initiated')
}))

/** Verifies the Razorpay Checkout callback. The order is only marked paid after the signature checks out. */
ordersRouter.post('/:id/payment/razorpay/verify', asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const input = verifySchema.parse(request.body)
  const order = await Order.findOne({ _id: id, userId: request.auth!.sub }).lean()
  if (!order) throw new ApiError(404, 'Order not found')
  if (order.payment?.razorpayOrderId !== input.razorpay_order_id) throw new ApiError(400, 'Payment does not belong to this order', [], 'PAYMENT_MISMATCH')
  if (!verifyPaymentSignature(input.razorpay_order_id, input.razorpay_payment_id, input.razorpay_signature)) {
    throw new ApiError(400, 'Payment verification failed', [], 'INVALID_SIGNATURE')
  }
  const { order: updated } = await markOrderPaid(input.razorpay_order_id, input.razorpay_payment_id)
  sendSuccess(response, await Order.findById(updated._id).select(customerProjection).lean(), 'Payment verified')
}))
