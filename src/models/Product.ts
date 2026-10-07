import { Schema, model, type InferSchemaType } from 'mongoose'

export const productStatuses = ['DRAFT', 'ACTIVE', 'OUT_OF_STOCK', 'ARCHIVED'] as const
/** Statuses visible on the public storefront. OUT_OF_STOCK products are shown but cannot be bought. */
export const publicProductStatuses = ['ACTIVE', 'OUT_OF_STOCK'] as const

const variantSchema = new Schema({
  label: { type: String, required: true, trim: true },
  // Uniqueness across products is enforced by the sparse unique index on `variants.sku` below.
  sku: { type: String, required: true, trim: true },
  price: { type: Number, required: true, min: 0 },
  stock: { type: Number, required: true, min: 0 },
  active: { type: Boolean, default: true },
}, { _id: true })

const productSchema = new Schema({
  slug: { type: String, required: true, unique: true },
  sku: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true, trim: true },
  category: { type: String, required: true },
  collection: { type: String, required: true },
  fragrance: { type: String, required: true },
  description: { type: String, required: true },
  shortDescription: { type: String, required: true },
  price: { type: Number, required: true, min: 0 },
  mrp: { type: Number, required: true, min: 0 },
  rating: { type: Number, default: 0, min: 0, max: 5 },
  reviews: { type: Number, default: 0, min: 0 },
  badge: String,
  stock: { type: Number, required: true, min: 0 },
  tags: [{ type: String }],
  images: [{ type: String }],
  thumbnailImage: { type: String, default: '' },
  variants: [variantSchema],
  status: { type: String, enum: productStatuses, default: 'ACTIVE' },
  featured: { type: Boolean, default: false },
  fragranceNotes: {
    top: [{ type: String }],
    heart: [{ type: String }],
    base: [{ type: String }],
  },
  specifications: [{ _id: false, label: { type: String, required: true }, value: { type: String, required: true } }],
  seo: {
    title: { type: String, default: '' },
    description: { type: String, default: '' },
  },
}, { timestamps: true, suppressReservedKeysWarning: true })

/** For products with variants, the product-level stock is the sum of active variant stock. */
productSchema.pre('validate', function syncAggregateStock() {
  if (this.variants.length > 0) {
    this.stock = this.variants.filter((variant) => variant.active !== false).reduce((sum, variant) => sum + variant.stock, 0)
  }
})

productSchema.index({ 'variants.sku': 1 }, { unique: true, sparse: true })
productSchema.index({ status: 1, category: 1 })
productSchema.index({ status: 1, collection: 1 })
productSchema.index({ status: 1, featured: -1, rating: -1 })
productSchema.index({ status: 1, createdAt: -1 })
productSchema.index({ tags: 1 })
productSchema.index({ name: 'text', description: 'text', fragrance: 'text', collection: 'text', tags: 'text' })

export type ProductShape = InferSchemaType<typeof productSchema>
export const Product = model('Product', productSchema)
