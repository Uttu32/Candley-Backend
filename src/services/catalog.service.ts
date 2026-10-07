import { Types } from 'mongoose'
import { Product, publicProductStatuses } from '../models/Product.js'

type VariantLike = { _id: Types.ObjectId; label: string; sku: string; price: number; stock: number; active?: boolean | null }
export type ProductLike = {
  _id: Types.ObjectId
  name: string
  slug: string
  sku: string
  price: number
  stock: number
  status: string
  category: string
  images: string[]
  thumbnailImage?: string | null
  variants: VariantLike[]
}

export type ResolvedLine = {
  product: ProductLike
  variant: VariantLike | null
  unitPrice: number
  stock: number
  sku: string
  /** Null when the line can be purchased; otherwise the reason it cannot. */
  issue: null | 'PRODUCT_UNAVAILABLE' | 'VARIANT_REQUIRED' | 'VARIANT_UNAVAILABLE' | 'OUT_OF_STOCK' | 'INSUFFICIENT_STOCK'
}

export const issueMessages: Record<NonNullable<ResolvedLine['issue']>, string> = {
  PRODUCT_UNAVAILABLE: 'This product is no longer available',
  VARIANT_REQUIRED: 'Please choose a size or variant',
  VARIANT_UNAVAILABLE: 'The selected variant is no longer available',
  OUT_OF_STOCK: 'Out of stock',
  INSUFFICIENT_STOCK: 'Only limited stock is available',
}

/** The storefront sends "default" for products without variants. */
export const normaliseVariantId = (variantId: unknown) =>
  typeof variantId === 'string' && variantId !== '' && variantId !== 'default' ? variantId : undefined

const activeVariants = (product: ProductLike) => (product.variants ?? []).filter((variant) => variant.active !== false)

/**
 * Resolves the authoritative price, stock and SKU for a product/variant pair.
 * Prices always come from the database, never from the client.
 */
export const resolveLine = (product: ProductLike | null | undefined, variantId: string | undefined, quantity: number): ResolvedLine | { product: null; issue: 'PRODUCT_UNAVAILABLE' } => {
  if (!product) return { product: null, issue: 'PRODUCT_UNAVAILABLE' }
  const base = { product, variant: null, unitPrice: product.price, stock: product.stock, sku: product.sku }
  if (product.status !== 'ACTIVE') {
    return { ...base, issue: product.status === 'OUT_OF_STOCK' ? 'OUT_OF_STOCK' : 'PRODUCT_UNAVAILABLE' }
  }
  const variants = activeVariants(product)
  let variant: VariantLike | null = null
  if (variantId) {
    variant = (product.variants ?? []).find((entry) => String(entry._id) === variantId) ?? null
    if (!variant || variant.active === false) return { ...base, issue: 'VARIANT_UNAVAILABLE' }
  } else if (variants.length === 1) {
    variant = variants[0]!
  } else if (variants.length > 1) {
    return { ...base, issue: 'VARIANT_REQUIRED' }
  }
  const resolved = variant
    ? { product, variant, unitPrice: variant.price, stock: variant.stock, sku: variant.sku }
    : base
  if (resolved.stock <= 0) return { ...resolved, issue: 'OUT_OF_STOCK' }
  if (resolved.stock < quantity) return { ...resolved, issue: 'INSUFFICIENT_STOCK' }
  return { ...resolved, issue: null }
}

export const loadProductsById = async (ids: Array<string | Types.ObjectId>) => {
  const unique = [...new Set(ids.map(String))].filter((id) => Types.ObjectId.isValid(id))
  const products = await Product.find({ _id: { $in: unique } }).lean<ProductLike[]>()
  return new Map(products.map((product) => [String(product._id), product]))
}

/** Public product projection: hides inactive variants. */
export const toPublicProduct = <T extends { variants?: Array<{ active?: boolean | null }> }>(product: T): T => ({
  ...product,
  variants: (product.variants ?? []).filter((variant) => variant.active !== false),
})

export const publicStatusFilter = { status: { $in: [...publicProductStatuses] } }
