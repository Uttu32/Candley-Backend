import { Schema, model } from 'mongoose'

const wishlistSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  productIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
}, { timestamps: true })

export const Wishlist = model('Wishlist', wishlistSchema)
