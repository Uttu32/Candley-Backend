import type { ClientSession, Types } from 'mongoose'
import { Coupon } from '../models/Coupon.js'
import { Order } from '../models/Order.js'
import { ApiError } from '../utils/api-error.js'
import type { Compensator } from './transaction.js'

type PricedLine = { productId: Types.ObjectId | string; category: string; lineTotal: number }

const roundMoney = (value: number) => Math.round(value * 100) / 100

const reject = (message: string) => new ApiError(422, message, [], 'COUPON_INVALID')

/** Validates a coupon for a user and cart, returning the server-calculated discount. */
export const evaluateCoupon = async (code: string, userId: string, lines: PricedLine[], session?: ClientSession) => {
  const coupon = await Coupon.findOne({ code: code.trim().toUpperCase() }).session(session ?? null).lean()
  if (!coupon || !coupon.active) throw reject('This coupon code is not valid')
  const now = new Date()
  if (coupon.startsAt && coupon.startsAt > now) throw reject('This coupon is not active yet')
  if (coupon.endsAt && coupon.endsAt < now) throw reject('This coupon has expired')
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) throw reject('This coupon has reached its usage limit')
  if (coupon.perCustomerLimit) {
    const used = await Order.countDocuments({ userId, couponId: coupon._id, status: { $ne: 'CANCELLED' } }).session(session ?? null)
    if (used >= coupon.perCustomerLimit) throw reject('You have already used this coupon')
  }

  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0)
  if (subtotal < coupon.minOrderValue) throw reject(`Add items worth ₹${coupon.minOrderValue} or more to use this coupon`)

  const productIds = new Set((coupon.productIds ?? []).map(String))
  const categories = new Set((coupon.categories ?? []).map((category) => category.toLowerCase()))
  const restricted = productIds.size > 0 || categories.size > 0
  const eligibleTotal = restricted
    ? lines.filter((line) => productIds.has(String(line.productId)) || categories.has(line.category.toLowerCase())).reduce((sum, line) => sum + line.lineTotal, 0)
    : subtotal
  if (eligibleTotal <= 0) throw reject('This coupon does not apply to the items in your cart')

  let discount = coupon.discountType === 'PERCENT' ? (eligibleTotal * coupon.amount) / 100 : coupon.amount
  if (coupon.maxDiscount !== undefined && coupon.maxDiscount !== null) discount = Math.min(discount, coupon.maxDiscount)
  discount = roundMoney(Math.min(discount, eligibleTotal))
  return { coupon, discount }
}

/** Atomically consumes one use of the coupon, failing if the global limit was reached concurrently. */
export const consumeCoupon = async (couponId: Types.ObjectId, session: ClientSession | undefined, compensator: Compensator) => {
  const result = await Coupon.updateOne(
    { _id: couponId, active: true, $or: [{ usageLimit: null }, { usageLimit: { $exists: false } }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }] },
    { $inc: { usedCount: 1 } },
    { session },
  )
  if (result.modifiedCount !== 1) throw reject('This coupon has reached its usage limit')
  compensator.add(() => Coupon.updateOne({ _id: couponId }, { $inc: { usedCount: -1 } }))
}

export const releaseCoupon = (couponId: Types.ObjectId, session: ClientSession | undefined) =>
  Coupon.updateOne({ _id: couponId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }, { session })
