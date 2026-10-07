import mongoose, { Types } from 'mongoose'
import { Cart } from '../models/Cart.js'
import { getStoreSettings } from '../models/StoreSettings.js'
import { ApiError } from '../utils/api-error.js'
import { issueMessages, loadProductsById, normaliseVariantId, resolveLine } from './catalog.service.js'

type CartDocument = NonNullable<Awaited<ReturnType<typeof Cart.findOne>>>

const sameLine = (item: { productId: unknown; variantId?: unknown }, productId: string, variantId: string | undefined) =>
  String(item.productId) === productId && (item.variantId ? String(item.variantId) : undefined) === variantId

/** Loads (or creates) the user's cart, applies `mutate`, and retries if a concurrent request saved first. */
export const mutateCart = async (userId: string, mutate: (cart: CartDocument) => Promise<void> | void) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const cart = (await Cart.findOne({ userId })) ?? new Cart({ userId, items: [] })
    await mutate(cart)
    try {
      await cart.save()
      return
    } catch (error) {
      const retryable = error instanceof mongoose.Error.VersionError || (error as { code?: number }).code === 11000
      if (!retryable || attempt === 3) throw error
    }
  }
}

/** Validates a requested quantity for a product/variant; returns the variant id to store and the most that may be held. */
const validateLine = async (productId: string, variantId: string | undefined, quantity: number) => {
  const [products, settings] = await Promise.all([loadProductsById([productId]), getStoreSettings()])
  if (quantity > settings.maxQuantityPerItem) throw new ApiError(422, `You can add up to ${settings.maxQuantityPerItem} of an item`, [], 'QUANTITY_LIMIT')
  const resolved = resolveLine(products.get(productId), variantId, quantity)
  if (!resolved.product || resolved.issue === 'PRODUCT_UNAVAILABLE') throw new ApiError(404, 'Product not found')
  if (resolved.issue) throw new ApiError(resolved.issue === 'INSUFFICIENT_STOCK' || resolved.issue === 'OUT_OF_STOCK' ? 409 : 422, issueMessages[resolved.issue], [{ available: Math.max(resolved.stock, 0) }], resolved.issue)
  return { variantId: resolved.variant ? String(resolved.variant._id) : undefined, maxQuantity: Math.min(resolved.stock, settings.maxQuantityPerItem) }
}

/**
 * Adds to the cart with atomic updates so concurrent adds never lose quantity: increment an existing line
 * only while the result stays within stock/limit, otherwise push a new line only if none exists yet.
 */
export const addItem = async (userId: string, productId: string, rawVariantId: string | undefined, quantity: number) => {
  const { variantId, maxQuantity } = await validateLine(productId, normaliseVariantId(rawVariantId), quantity)
  const lineMatch = { productId: new Types.ObjectId(productId), variantId: variantId ? new Types.ObjectId(variantId) : null }
  try {
    await Cart.updateOne({ userId }, { $setOnInsert: { userId, items: [] } }, { upsert: true })
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error // a concurrent request created the cart
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const incremented = await Cart.updateOne(
      { userId, items: { $elemMatch: { ...lineMatch, quantity: { $lte: maxQuantity - quantity } } } },
      { $inc: { 'items.$.quantity': quantity } },
    )
    if (incremented.modifiedCount === 1) return getCartView(userId)
    if (await Cart.exists({ userId, items: { $elemMatch: { ...lineMatch, quantity: { $gt: maxQuantity - quantity } } } })) {
      throw new ApiError(409, issueMessages.INSUFFICIENT_STOCK, [{ available: maxQuantity }], 'INSUFFICIENT_STOCK')
    }
    const pushed = await Cart.updateOne(
      { userId, items: { $not: { $elemMatch: lineMatch } } },
      { $push: { items: { productId, variantId, quantity } } },
    )
    if (pushed.modifiedCount === 1) return getCartView(userId)
    // Another request created the line between our checks; retry the increment.
  }
  throw new ApiError(409, 'The cart is being updated, please try again', [], 'CONCURRENT_UPDATE')
}

/** Finds the line to change. Without a variant id, the request must be unambiguous. */
const findLine = (cart: CartDocument, productId: string, variantId: string | undefined) => {
  if (variantId) return cart.items.find((item) => sameLine(item, productId, variantId))
  const matches = cart.items.filter((item) => String(item.productId) === productId)
  if (matches.length > 1) throw new ApiError(422, 'variantId is required: this product has several variants in the cart', [], 'VARIANT_REQUIRED')
  return matches[0]
}

export const setItemQuantity = async (userId: string, productId: string, rawVariantId: string | undefined, quantity: number) => {
  const variantId = normaliseVariantId(rawVariantId)
  await mutateCart(userId, async (cart) => {
    const line = findLine(cart, productId, variantId)
    if (!line) throw new ApiError(404, 'Cart item not found')
    if (quantity === 0) {
      cart.items.pull(line._id)
      return
    }
    if (quantity > line.quantity) await validateLine(productId, line.variantId ? String(line.variantId) : undefined, quantity)
    line.quantity = quantity
  })
  return getCartView(userId)
}

export const removeItem = async (userId: string, productId: string, rawVariantId: string | undefined) => {
  const variantId = normaliseVariantId(rawVariantId)
  // Without a variant id every line for the product is removed (existing frontend behaviour).
  const filter = variantId ? { productId, variantId } : { productId }
  await Cart.updateOne({ userId }, { $pull: { items: filter } })
  return getCartView(userId)
}

export const clearCart = async (userId: string) => {
  await Cart.updateOne({ userId }, { $set: { items: [] } })
  return getCartView(userId)
}

/**
 * Cart response: each item carries the populated product (existing contract), plus the server-resolved
 * variant, current unit price, line total and any availability issue so the UI can react to changes.
 */
export const getCartView = async (userId: string) => {
  const cart = await Cart.findOne({ userId }).lean()
  const items = cart?.items ?? []
  const products = await loadProductsById(items.map((item) => item.productId))
  const view = items.map((item) => {
    const product = products.get(String(item.productId)) ?? null
    const resolved = resolveLine(product, item.variantId ? String(item.variantId) : undefined, item.quantity)
    const unitPrice = resolved.product ? resolved.unitPrice : 0
    const available = resolved.issue === null
    return {
      _id: String(item._id),
      productId: product ? { ...product, variants: (product.variants ?? []).filter((variant) => variant.active !== false) } : null,
      variantId: item.variantId ? String(item.variantId) : undefined,
      variant: resolved.product && resolved.variant ? { _id: String(resolved.variant._id), label: resolved.variant.label, price: resolved.variant.price, stock: resolved.variant.stock, sku: resolved.variant.sku } : null,
      quantity: item.quantity,
      unitPrice,
      lineTotal: available ? unitPrice * item.quantity : 0,
      available,
      maxQuantity: resolved.product ? Math.max(resolved.stock, 0) : 0,
      issue: resolved.issue,
      issueMessage: resolved.issue ? issueMessages[resolved.issue] : null,
    }
  })
  const purchasable = view.filter((item) => item.available)
  return {
    userId,
    // Lines whose product was deleted are omitted; the storefront dereferences `productId._id`.
    items: view.filter((item) => item.productId !== null),
    subtotal: purchasable.reduce((sum, item) => sum + item.lineTotal, 0),
    itemCount: purchasable.reduce((sum, item) => sum + item.quantity, 0),
    hasIssues: view.some((item) => !item.available),
    updatedAt: cart?.updatedAt ?? null,
  }
}
