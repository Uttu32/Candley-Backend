import { Schema, model } from 'mongoose'

const cartSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  items: [{
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId },
    quantity: { type: Number, min: 1, max: 99, required: true },
  }],
  /** Set when a checkout claims this cart; bumps `updatedAt` so concurrent checkouts of the same cart conflict. */
  checkoutClaimedAt: { type: Date },
}, { timestamps: true, optimisticConcurrency: true })

export const Cart = model('Cart', cartSchema)
