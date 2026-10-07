import { Router } from 'express'
import { z } from 'zod'
import { Category } from '../../models/Category.js'
import { Coupon } from '../../models/Coupon.js'
import { Product } from '../../models/Product.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { ApiError } from '../../utils/api-error.js'
import { sendSuccess } from '../../utils/response.js'
import { escapeRegex, mediaUrlSchema, objectIdSchema, paginate, paginationSchema, slugSchema } from '../../utils/validation.js'

const categorySchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: slugSchema,
  image: z.union([mediaUrlSchema, z.literal('')]).optional(),
  description: z.string().trim().max(500).optional(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
}).strict()

export const adminCategoriesRouter = Router()

adminCategoriesRouter.get('/', asyncHandler(async (_request, response) => {
  sendSuccess(response, await Category.find().sort({ sortOrder: 1, name: 1 }).lean())
}))

adminCategoriesRouter.post('/', asyncHandler(async (request, response) => {
  sendSuccess(response, await Category.create(categorySchema.parse(request.body)), 'Category created', 201)
}))

adminCategoriesRouter.patch('/:id', asyncHandler(async (request, response) => {
  const input = categorySchema.partial().parse(request.body)
  const category = await Category.findByIdAndUpdate(objectIdSchema.parse(request.params.id), { $set: input }, { new: true, runValidators: true })
  if (!category) throw new ApiError(404, 'Category not found')
  sendSuccess(response, category, 'Category updated')
}))

/** Categories still used by products cannot be deleted; deactivate them instead. */
adminCategoriesRouter.delete('/:id', asyncHandler(async (request, response) => {
  const category = await Category.findById(objectIdSchema.parse(request.params.id))
  if (!category) throw new ApiError(404, 'Category not found')
  const inUse = await Product.countDocuments({ category: new RegExp(`^${escapeRegex(category.name)}$`, 'i') })
  if (inUse > 0) throw new ApiError(409, `${inUse} product(s) use this category; reassign them or deactivate the category`, [], 'CATEGORY_IN_USE')
  await category.deleteOne()
  sendSuccess(response, null, 'Category deleted')
}))

const couponSchema = z.object({
  code: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, dashes or underscores').transform((value) => value.toUpperCase()),
  description: z.string().trim().max(200).default(''),
  active: z.boolean().default(true),
  discountType: z.enum(['PERCENT', 'FIXED']),
  amount: z.number().positive().max(1_000_000),
  minOrderValue: z.number().nonnegative().max(10_000_000).default(0),
  maxDiscount: z.number().positive().max(1_000_000).nullable().optional(),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  usageLimit: z.number().int().positive().nullable().optional(),
  perCustomerLimit: z.number().int().positive().nullable().optional(),
  productIds: z.array(objectIdSchema).max(500).default([]),
  categories: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
}).strict()

const assertCoupon = (coupon: { discountType?: string; amount?: number; startsAt?: Date | null; endsAt?: Date | null }) => {
  if (coupon.discountType === 'PERCENT' && coupon.amount !== undefined && coupon.amount > 100) throw new ApiError(400, 'amount: percentage discounts cannot exceed 100', [], 'VALIDATION_ERROR')
  if (coupon.startsAt && coupon.endsAt && coupon.endsAt <= coupon.startsAt) throw new ApiError(400, 'endsAt must be after startsAt', [], 'VALIDATION_ERROR')
}

export const adminCouponsRouter = Router()

adminCouponsRouter.get('/', asyncHandler(async (request, response) => {
  const { page, limit } = paginationSchema.parse(request.query)
  const [items, total] = await Promise.all([
    Coupon.find().sort({ createdAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Coupon.countDocuments(),
  ])
  sendSuccess(response, { items, pagination: paginate(page, limit, total) })
}))

adminCouponsRouter.post('/', asyncHandler(async (request, response) => {
  const input = couponSchema.parse(request.body)
  assertCoupon(input)
  sendSuccess(response, await Coupon.create(input), 'Coupon created', 201)
}))

adminCouponsRouter.patch('/:id', asyncHandler(async (request, response) => {
  const input = couponSchema.partial().parse(request.body)
  const coupon = await Coupon.findById(objectIdSchema.parse(request.params.id))
  if (!coupon) throw new ApiError(404, 'Coupon not found')
  assertCoupon({ discountType: input.discountType ?? coupon.discountType, amount: input.amount ?? coupon.amount, startsAt: input.startsAt === undefined ? coupon.startsAt : input.startsAt, endsAt: input.endsAt === undefined ? coupon.endsAt : input.endsAt })
  coupon.set(input)
  await coupon.save()
  sendSuccess(response, coupon, 'Coupon updated')
}))

/** Used coupons are deactivated rather than deleted so order history keeps its reference. */
adminCouponsRouter.delete('/:id', asyncHandler(async (request, response) => {
  const coupon = await Coupon.findById(objectIdSchema.parse(request.params.id))
  if (!coupon) throw new ApiError(404, 'Coupon not found')
  if (coupon.usedCount > 0) {
    coupon.active = false
    await coupon.save()
    sendSuccess(response, { deleted: false, deactivated: true }, 'Coupon has been used, so it was deactivated')
    return
  }
  await coupon.deleteOne()
  sendSuccess(response, { deleted: true, deactivated: false }, 'Coupon deleted')
}))
