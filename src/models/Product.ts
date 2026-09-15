import { Schema, model } from 'mongoose'

const variantSchema = new Schema({
  label: { type: String, required: true },
  sku: { type: String, required: true, unique: true },
  price: { type: Number, required: true, min: 0 },
  stock: { type: Number, required: true, min: 0 },
}, { _id: true })

const productSchema = new Schema({
  slug: { type: String, required: true, unique: true, index: true },
  sku: { type: String, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  category: { type: String, required: true, index: true },
  collection: { type: String, required: true, index: true },
  fragrance: { type: String, required: true },
  description: { type: String, required: true },
  shortDescription: { type: String, required: true },
  price: { type: Number, required: true, min: 0 },
  mrp: { type: Number, required: true, min: 0 },
  rating: { type: Number, default: 0, min: 0, max: 5 },
  reviews: { type: Number, default: 0, min: 0 },
  badge: String,
  stock: { type: Number, required: true, min: 0 },
  tags: [{ type: String, index: true }],
  images: [{ type: String }],
  variants: [variantSchema],
  status: { type: String, enum: ['DRAFT', 'ACTIVE', 'OUT_OF_STOCK', 'ARCHIVED'], default: 'ACTIVE', index: true },
  featured: { type: Boolean, default: false },
}, { timestamps: true })

productSchema.index({ name: 'text', description: 'text', fragrance: 'text', collection: 'text', tags: 'text' })
export const Product = model('Product', productSchema)
