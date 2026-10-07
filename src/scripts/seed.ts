/**
 * Development catalogue seed. Inserts sample categories and one product only if they do not exist.
 * It never creates, modifies or deletes user accounts (use `npm run admin:create` for administrators)
 * and refuses to run against production.
 */
import { connectDatabase, disconnectDatabase } from '../config/database.js'
import { env } from '../config/env.js'
import { Product } from '../models/Product.js'
import { Category } from '../models/Category.js'

const seed = async () => {
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed sample data in production')
  await connectDatabase()

  await Category.bulkWrite([
    { updateOne: { filter: { slug: 'soy-candles' }, update: { $setOnInsert: { name: 'Soy Candles', image: '/images/musk-rose-collection.png' } }, upsert: true } },
    { updateOne: { filter: { slug: 'luxury-candles' }, update: { $setOnInsert: { name: 'Luxury Candles', image: '/images/lotus-urli-candle.png' } }, upsert: true } },
    { updateOne: { filter: { slug: 'floral' }, update: { $setOnInsert: { name: 'Floral', image: '/images/musk-rose-candle.png' } }, upsert: true } },
  ])
  await Product.updateOne({ slug: 'amber-silk-candle' }, { $setOnInsert: { slug: 'amber-silk-candle', sku: 'CAN-AMBER', name: 'Amber Silk Candle', category: 'Luxury Candles', collection: 'Midnight Bloom', fragrance: 'Vanilla & Musk', description: 'A warm amber glow with soft vanilla musk and sandalwood nuances.', shortDescription: 'Warm, velvety, and quietly indulgent.', price: 1499, mrp: 1899, rating: 0, reviews: 0, stock: 12, tags: ['warm', 'amber', 'giftable'], images: ['/images/musk-rose-candle.png'], thumbnailImage: '/images/musk-rose-candle.png', variants: [{ label: '200g', sku: 'CAN-AMBER-200', price: 1499, stock: 12, active: true }], status: 'ACTIVE' } }, { upsert: true })
  await disconnectDatabase()
}

seed().then(() => console.log('Seed complete')).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
