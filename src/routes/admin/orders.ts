import { Router } from 'express'
import { z } from 'zod'
import { Order, orderStatuses, paymentMethods, paymentStatuses } from '../../models/Order.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { ApiError } from '../../utils/api-error.js'
import { sendSuccess } from '../../utils/response.js'
import { escapeRegex, objectIdSchema, paginate, paginationSchema } from '../../utils/validation.js'
import { markCodCollected, updateOrderStatus } from '../../services/order.service.js'

const listQuerySchema = paginationSchema.extend({
  status: z.enum(orderStatuses).optional(),
  paymentStatus: z.enum(paymentStatuses).optional(),
  paymentMethod: z.enum(paymentMethods).optional(),
  search: z.string().trim().max(60).optional(),
  customerId: objectIdSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

export const adminOrdersRouter = Router()

adminOrdersRouter.get('/', asyncHandler(async (request, response) => {
  const query = listQuerySchema.parse(request.query)
  const filter: Record<string, unknown> = {}
  if (query.status) filter.status = query.status
  if (query.paymentStatus) filter.paymentStatus = query.paymentStatus
  if (query.paymentMethod) filter.paymentMethod = query.paymentMethod
  if (query.customerId) filter.userId = query.customerId
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i')
    filter.$or = [{ orderNumber: pattern }, { 'shippingAddress.name': pattern }, { 'shippingAddress.phone': pattern }]
  }
  if (query.from || query.to) filter.createdAt = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) }
  const [items, total] = await Promise.all([
    Order.find(filter).select('-checkoutFingerprint -idempotencyKey').populate('userId', 'name email').sort({ createdAt: -1, _id: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Order.countDocuments(filter),
  ])
  sendSuccess(response, { items, pagination: paginate(query.page, query.limit, total) })
}))

adminOrdersRouter.get('/:id', asyncHandler(async (request, response) => {
  const order = await Order.findById(objectIdSchema.parse(request.params.id)).select('-checkoutFingerprint -idempotencyKey').populate('userId', 'name email phone').populate('statusHistory.changedBy', 'name email').lean()
  if (!order) throw new ApiError(404, 'Order not found')
  sendSuccess(response, order)
}))

adminOrdersRouter.patch('/:id/status', asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const { status, note } = z.object({ status: z.enum(orderStatuses), note: z.string().trim().max(300).optional() }).parse(request.body)
  if (status === 'PENDING_PAYMENT') throw new ApiError(422, 'Orders cannot be moved back to pending payment', [], 'INVALID_STATUS_TRANSITION')
  await updateOrderStatus(id, status, request.auth!.sub, note)
  sendSuccess(response, await Order.findById(id).lean(), 'Order status updated')
}))

adminOrdersRouter.post('/:id/cod-collected', asyncHandler(async (request, response) => {
  sendSuccess(response, await markCodCollected(objectIdSchema.parse(request.params.id), request.auth!.sub), 'COD payment recorded')
}))
