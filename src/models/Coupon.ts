import { Schema, model, type InferSchemaType } from 'mongoose'

const couponSchema = new Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  description: { type: String, default: '' },
  active: { type: Boolean, default: true },
  discountType: { type: String, enum: ['PERCENT', 'FIXED'], required: true },
  /** Percentage (0-100] for PERCENT, rupees for FIXED. */
  amount: { type: Number, required: true, min: 0 },
  minOrderValue: { type: Number, default: 0, min: 0 },
  maxDiscount: { type: Number, min: 0 },
  startsAt: { type: Date },
  endsAt: { type: Date },
  usageLimit: { type: Number, min: 1 },
  perCustomerLimit: { type: Number, min: 1 },
  usedCount: { type: Number, default: 0, min: 0 },
  /** Optional eligibility: when non-empty, only matching lines count toward the discount. */
  productIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
  categories: [{ type: String }],
}, { timestamps: true })

export type CouponShape = InferSchemaType<typeof couponSchema>
export const Coupon = model('Coupon', couponSchema)
