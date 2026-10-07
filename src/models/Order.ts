import { Schema, model, type InferSchemaType } from 'mongoose'

export const orderStatuses = ['PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const
export const paymentStatuses = ['PENDING', 'PAID', 'FAILED', 'REFUNDED'] as const
export const paymentMethods = ['RAZORPAY', 'COD'] as const
export type OrderStatus = (typeof orderStatuses)[number]
export type PaymentStatus = (typeof paymentStatuses)[number]

const orderItemSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: Schema.Types.ObjectId },
  productName: { type: String, required: true },
  productSlug: { type: String },
  variantLabel: { type: String },
  sku: { type: String, required: true },
  image: { type: String, default: '' },
  thumbnailImage: { type: String, default: '' },
  unitPrice: { type: Number, required: true, min: 0 },
  quantity: { type: Number, required: true, min: 1 },
  lineTotal: { type: Number, required: true, min: 0 },
}, { _id: false })

const orderSchema = new Schema({
  orderNumber: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  items: { type: [orderItemSchema], required: true },
  shippingAddress: {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    addressLine1: { type: String, required: true },
    addressLine2: { type: String, default: '' },
    city: { type: String, required: true },
    state: { type: String, required: true },
    postalCode: { type: String, required: true },
    country: { type: String, required: true },
  },
  subtotal: { type: Number, required: true, min: 0 },
  discount: { type: Number, default: 0, min: 0 },
  couponCode: { type: String },
  couponId: { type: Schema.Types.ObjectId, ref: 'Coupon' },
  shipping: { type: Number, required: true, min: 0 },
  tax: { type: Number, default: 0, min: 0 },
  total: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'INR' },
  paymentMethod: { type: String, enum: paymentMethods, required: true },
  paymentStatus: { type: String, enum: paymentStatuses, default: 'PENDING' },
  status: { type: String, enum: orderStatuses, default: 'PENDING_PAYMENT' },
  payment: {
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    paidAt: { type: Date },
    failureReason: { type: String },
  },
  /** Client-supplied key that makes checkout submission idempotent per customer. */
  idempotencyKey: { type: String },
  /** Hash of cart lines, address, payment method and coupon; a repeat submission returns the pending order. */
  checkoutFingerprint: { type: String },
  /** Unpaid online orders release their reserved stock after this time. */
  reservationExpiresAt: { type: Date },
  /** True once reserved stock has been returned (cancellation/expiry); prevents double restock. */
  inventoryReleased: { type: Boolean, default: false },
  statusHistory: [{
    _id: false,
    status: { type: String, enum: orderStatuses, required: true },
    note: { type: String },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
  }],
  cancelledAt: { type: Date },
  cancellationReason: { type: String },
  cancelledBy: { type: String, enum: ['customer', 'admin', 'system'] },
}, { timestamps: true })

orderSchema.index({ userId: 1, createdAt: -1 })
orderSchema.index({ status: 1, createdAt: -1 })
orderSchema.index({ paymentStatus: 1, createdAt: -1 })
orderSchema.index({ 'payment.razorpayOrderId': 1 }, { unique: true, sparse: true })
orderSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } })
orderSchema.index({ status: 1, reservationExpiresAt: 1 }, { partialFilterExpression: { status: 'PENDING_PAYMENT' } })

export type OrderShape = InferSchemaType<typeof orderSchema>
export const Order = model('Order', orderSchema)
