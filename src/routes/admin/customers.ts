import { Router } from 'express'
import { z } from 'zod'
import { User } from '../../models/User.js'
import { Order } from '../../models/Order.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { ApiError } from '../../utils/api-error.js'
import { sendSuccess } from '../../utils/response.js'
import { escapeRegex, objectIdSchema, paginate, paginationSchema } from '../../utils/validation.js'
import { revokeAllSessions } from '../../services/session.service.js'

/** Customer fields visible to admins. Password hashes, reset tokens and token versions are never selected. */
const customerFields = 'name email phone status emailVerified createdAt lastLoginAt addresses'

const listQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'BLOCKED', 'SUSPENDED']).optional(),
})

export const adminCustomersRouter = Router()

adminCustomersRouter.get('/', asyncHandler(async (request, response) => {
  const { page, limit, search, status } = listQuerySchema.parse(request.query)
  const filter: Record<string, unknown> = { role: 'CUSTOMER', status: status ?? { $ne: 'DELETED' } }
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i')
    filter.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }]
  }
  const [customers, total] = await Promise.all([
    User.find(filter).select(customerFields.replace(' addresses', '')).sort({ createdAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(filter),
  ])
  const stats = await Order.aggregate<{ _id: unknown; orders: number; spent: number }>([
    { $match: { userId: { $in: customers.map((customer) => customer._id) } } },
    { $group: { _id: '$userId', orders: { $sum: 1 }, spent: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'PAID'] }, '$total', 0] } } } },
  ])
  const statsById = new Map(stats.map((entry) => [String(entry._id), entry]))
  const items = customers.map((customer) => ({ ...customer, orderCount: statsById.get(String(customer._id))?.orders ?? 0, totalSpent: statsById.get(String(customer._id))?.spent ?? 0 }))
  sendSuccess(response, { items, pagination: paginate(page, limit, total) })
}))

adminCustomersRouter.get('/:id', asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const customer = await User.findOne({ _id: id, role: 'CUSTOMER' }).select(customerFields).lean()
  if (!customer) throw new ApiError(404, 'Customer not found')
  const recentOrders = await Order.find({ userId: id }).select('orderNumber total status paymentStatus paymentMethod createdAt').sort({ createdAt: -1 }).limit(20).lean()
  sendSuccess(response, { ...customer, recentOrders })
}))

/** Blocks or reactivates a customer. Admin accounts cannot be changed here, and roles are never editable via the API. */
adminCustomersRouter.patch('/:id/status', asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const { status } = z.object({ status: z.enum(['ACTIVE', 'BLOCKED', 'SUSPENDED']) }).parse(request.body)
  const customer = await User.findOneAndUpdate({ _id: id, role: 'CUSTOMER' }, { $set: { status } }, { new: true }).select(customerFields).lean()
  if (!customer) throw new ApiError(404, 'Customer not found')
  if (status !== 'ACTIVE') await revokeAllSessions(id)
  sendSuccess(response, customer, 'Customer status updated')
}))
