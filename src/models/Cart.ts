import { Schema, model } from 'mongoose'

const cartSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  items: [{ productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true }, variantId: Schema.Types.ObjectId, quantity: { type: Number, min: 1, required: true } }],
}, { timestamps: true })

export const Cart = model('Cart', cartSchema)
