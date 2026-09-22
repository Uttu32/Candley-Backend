import argon2 from 'argon2'
import { connectDatabase, disconnectDatabase } from '../config/database.js'
import { env } from '../config/env.js'
import { User } from '../models/User.js'
import { Product } from '../models/Product.js'
import { Category } from '../models/Category.js'

const seed = async () => {
  await connectDatabase()

  const passwordHash = await argon2.hash(env.ADMIN_PASSWORD)
  await User.deleteMany({ role: { $in: ['ADMIN', 'SUPER_ADMIN'] }, email: { $ne: env.ADMIN_EMAIL.toLowerCase() } })
  await User.findOneAndUpdate(
    { email: env.ADMIN_EMAIL.toLowerCase() },
    {
      $set: {
        name: 'Store administrator',
        email: env.ADMIN_EMAIL.toLowerCase(),
        passwordHash,
        role: 'ADMIN',
        emailVerified: true,
        status: 'ACTIVE',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )

  await Category.bulkWrite([
    { updateOne: { filter: { slug: 'soy-candles' }, update: { $set: { name: 'Soy Candles', image: '/images/musk-rose-collection.png' } }, upsert: true } },
    { updateOne: { filter: { slug: 'luxury-candles' }, update: { $set: { name: 'Luxury Candles', image: '/images/lotus-urli-candle.png' } }, upsert: true } },
    { updateOne: { filter: { slug: 'floral' }, update: { $set: { name: 'Floral', image: '/images/musk-rose-candle.png' } }, upsert: true } },
  ])
  await Product.updateOne({ slug: 'amber-silk-candle' }, { $setOnInsert: { slug: 'amber-silk-candle', sku: 'CAN-AMBER-200', name: 'Amber Silk Candle', category: 'Luxury Candles', collection: 'Midnight Bloom', fragrance: 'Vanilla & Musk', description: 'A warm amber glow with soft vanilla musk and sandalwood nuances.', shortDescription: 'Warm, velvety, and quietly indulgent.', price: 1499, mrp: 1899, rating: 4.8, reviews: 91, badge: 'Bestseller', stock: 18, tags: ['warm', 'amber', 'giftable'], images: ['/images/musk-rose-candle.png'], variants: [{ label: '200g', sku: 'CAN-AMBER-200', price: 1499, stock: 12 }] } }, { upsert: true })
  await disconnectDatabase()
}
seed().then(() => console.log('Seed complete')).catch((error) => { console.error(error); process.exitCode = 1 })
