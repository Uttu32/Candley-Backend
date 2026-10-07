import { Types, type ClientSession } from 'mongoose'
import { Product } from '../models/Product.js'
import { ApiError } from '../utils/api-error.js'
import type { Compensator } from './transaction.js'

export type StockLine = { productId: Types.ObjectId | string; variantId?: Types.ObjectId | string | null; quantity: number; productName?: string }

/**
 * Adjusts stock by `delta` (negative = take, positive = return). For variant lines the variant's stock
 * and the product's aggregate stock move together. A pipeline update keeps the aggregate from going negative
 * even if legacy data left it out of sync with the variants.
 */
const adjust = (line: StockLine, delta: number, session: ClientSession | undefined, guard: boolean) => {
  const productId = new Types.ObjectId(String(line.productId))
  if (line.variantId) {
    const variantId = new Types.ObjectId(String(line.variantId))
    const filter = guard
      ? { _id: productId, status: 'ACTIVE' as const, variants: { $elemMatch: { _id: variantId, active: { $ne: false }, stock: { $gte: -delta } } } }
      : { _id: productId, 'variants._id': variantId }
    return Product.updateOne(filter, [{
      $set: {
        variants: {
          $map: {
            input: '$variants',
            as: 'v',
            in: { $cond: [{ $eq: ['$$v._id', variantId] }, { $mergeObjects: ['$$v', { stock: { $add: ['$$v.stock', delta] } }] }, '$$v'] },
          },
        },
        stock: { $max: [0, { $add: ['$stock', delta] }] },
      },
    }], { session, updatePipeline: true })
  }
  const filter = guard ? { _id: productId, status: 'ACTIVE' as const, stock: { $gte: -delta } } : { _id: productId }
  return Product.updateOne(filter, { $inc: { stock: delta } }, { session })
}

/** Atomically takes stock for every line or throws 409. Each successful take registers its own undo step. */
export const reserveStock = async (lines: StockLine[], session: ClientSession | undefined, compensator: Compensator) => {
  for (const line of lines) {
    const result = await adjust(line, -line.quantity, session, true)
    if (result.modifiedCount !== 1) {
      throw new ApiError(409, `${line.productName ?? 'An item'} no longer has enough stock`, [{ productId: String(line.productId), variantId: line.variantId ? String(line.variantId) : null }], 'INSUFFICIENT_STOCK')
    }
    compensator.add(() => adjust(line, line.quantity, undefined, false))
  }
}

export const releaseStock = async (lines: StockLine[], session: ClientSession | undefined) => {
  for (const line of lines) await adjust(line, line.quantity, session, false)
}
