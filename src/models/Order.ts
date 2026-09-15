import { Schema, model } from 'mongoose'

const orderSchema = new Schema({
  orderNumber: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  items: [{ productId: Schema.Types.ObjectId, variantId: Schema.Types.ObjectId, productName: String, sku: String, image: String, unitPrice: Number, quantity: Number, lineTotal: Number }],
  shippingAddress: { name: String, phone: String, addressLine1: String, city: String, state: String, postalCode: String, country: String },
  subtotal: Number,
  shipping: Number,
  tax: Number,
  total: Number,
  paymentMethod: { type: String, enum: ['RAZORPAY', 'COD'] },
  paymentStatus: { type: String, enum: ['PENDING', 'PAID', 'FAILED'], default: 'PENDING' },
  status: { type: String, enum: ['PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'], default: 'PENDING_PAYMENT' },
}, { timestamps: true })

export const Order = model('Order', orderSchema)
