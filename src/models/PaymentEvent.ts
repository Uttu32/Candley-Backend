import { Schema, model } from 'mongoose'

/** Processed Razorpay webhook events; the unique eventId makes webhook handling idempotent. */
const paymentEventSchema = new Schema({
  eventId: { type: String, required: true, unique: true },
  event: { type: String, required: true },
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
  outcome: { type: String },
}, { timestamps: true })

export const PaymentEvent = model('PaymentEvent', paymentEventSchema)
