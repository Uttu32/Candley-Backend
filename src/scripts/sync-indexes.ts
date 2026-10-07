/**
 * Index migration. Checks for duplicate values that would block unique indexes, recomputes product
 * aggregate stock for variant products, then syncs every model's indexes (creating new ones and dropping
 * indexes no longer declared in the schemas).
 *
 *   npm run db:sync-indexes            # report only (dry run)
 *   npm run db:sync-indexes -- --apply # apply changes
 */
import mongoose from 'mongoose'
import { connectDatabase, disconnectDatabase } from '../config/database.js'
import { User } from '../models/User.js'
import { Product } from '../models/Product.js'
import { Order } from '../models/Order.js'
import { Cart } from '../models/Cart.js'
import { Category } from '../models/Category.js'
import { Coupon } from '../models/Coupon.js'
import { HeroSlide } from '../models/HeroSlide.js'
import { PaymentEvent } from '../models/PaymentEvent.js'
import { RefreshToken } from '../models/RefreshToken.js'
import { StoreSettings } from '../models/StoreSettings.js'
import { Wishlist } from '../models/Wishlist.js'
import { Announcement } from '../models/Announcement.js'

const apply = process.argv.includes('--apply')

const duplicates = async (model: mongoose.Model<any>, field: string, unwind?: string) => {
  const pipeline: mongoose.PipelineStage[] = []
  if (unwind) pipeline.push({ $unwind: `$${unwind}` })
  pipeline.push(
    { $match: { [field]: { $exists: true, $ne: null } } },
    { $group: { _id: field === 'email' ? { $toLower: `$${field}` } : `$${field}`, count: { $sum: 1 }, ids: { $addToSet: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
  )
  // Variant SKUs repeated inside one product are a single-document problem; count distinct documents.
  const rows = await model.aggregate(pipeline)
  return rows.filter((row) => !unwind || row.ids.length > 1)
}

const main = async () => {
  await connectDatabase()
  try {
    const checks = [
      ['users.email', await duplicates(User, 'email')],
      ['products.slug', await duplicates(Product, 'slug')],
      ['products.sku', await duplicates(Product, 'sku')],
      ['products.variants.sku', await duplicates(Product, 'variants.sku', 'variants')],
      ['orders.orderNumber', await duplicates(Order, 'orderNumber')],
      ['categories.slug', await duplicates(Category, 'slug')],
    ] as const
    let blocked = false
    for (const [name, rows] of checks) {
      if (rows.length) {
        blocked = true
        console.log(`Duplicate values for ${name}:`, rows.map((row) => ({ value: row._id, count: row.count })))
      }
    }
    if (blocked) {
      console.log('Resolve the duplicates above before syncing unique indexes. No changes were made.')
      process.exitCode = 1
      return
    }

    const variantProducts = await Product.find({ 'variants.0': { $exists: true } })
    const drifted = variantProducts.filter((product) => product.stock !== product.variants.filter((variant) => variant.active !== false).reduce((sum, variant) => sum + variant.stock, 0))
    console.log(`${drifted.length} variant product(s) with aggregate stock out of sync`)

    const models = [User, Product, Order, Cart, Category, Coupon, HeroSlide, PaymentEvent, RefreshToken, StoreSettings, Wishlist, Announcement]
    for (const model of models) {
      const diff = await model.diffIndexes()
      if (diff.toCreate.length || diff.toDrop.length) console.log(`${model.modelName}: create ${JSON.stringify(diff.toCreate)} drop ${JSON.stringify(diff.toDrop)}`)
    }

    if (!apply) {
      console.log('Dry run complete. Re-run with --apply to make these changes.')
      return
    }
    for (const product of drifted) await product.save() // the pre-validate hook recomputes stock
    for (const model of models) await model.syncIndexes()
    console.log('Indexes synced.')
  } finally {
    await disconnectDatabase()
  }
}

main().catch((error) => {
  console.error(`Index sync failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
