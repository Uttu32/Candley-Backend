/**
 * Starts the real API against a throwaway in-memory MongoDB replica set with seed data, for the
 * frontend's Playwright end-to-end tests. Never touches a real database. Usage: `npx tsx tests/e2e-server.ts`.
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server'

const port = Number(process.env.E2E_API_PORT ?? 5055)
const clientUrl = process.env.E2E_CLIENT_URL ?? 'http://localhost:5174'

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: String(port),
  CLIENT_URL: clientUrl,
  ADMIN_URL: clientUrl,
  MONGO_URI: replSet.getUri('candley_e2e'),
  JWT_ACCESS_SECRET: 'e2e-access-secret-e2e-access-secret-000001',
  JWT_REFRESH_SECRET: 'e2e-refresh-secret-e2e-refresh-secret-00002',
  // Online payments stay disabled: Razorpay is exercised by unit tests with a stubbed client.
  RAZORPAY_KEY_ID: '',
  RAZORPAY_KEY_SECRET: '',
  CLOUDINARY_CLOUD_NAME: '',
  CLOUDINARY_API_KEY: '',
  CLOUDINARY_API_SECRET: '',
  SMTP_HOST: '',
})

const { default: mongoose } = await import('mongoose')
const { default: argon2 } = await import('argon2')
const { app } = await import('../src/app.js')
const { User } = await import('../src/models/User.js')
const { Product } = await import('../src/models/Product.js')
const { Category } = await import('../src/models/Category.js')
const { HeroSlide } = await import('../src/models/HeroSlide.js')

await mongoose.connect(process.env.MONGO_URI!)
await Promise.all(Object.values(mongoose.models).map((model) => model.init()))

const passwordHash = await argon2.hash('CorrectHorse!42')
await User.create([
  { name: 'Store Admin', email: 'admin@e2e.test', passwordHash, role: 'ADMIN', emailVerified: true },
  { name: 'Asha Rao', email: 'asha@e2e.test', passwordHash, role: 'CUSTOMER', emailVerified: true },
])
await Category.create([{ name: 'Luxury Candles', slug: 'luxury-candles', sortOrder: 1 }, { name: 'Soy Candles', slug: 'soy-candles', sortOrder: 2 }])
const image = '/candley-aroma-round-logo.svg'
await Product.create([
  { slug: 'amber-silk', sku: 'AMBER', name: 'Amber Silk', category: 'Luxury Candles', collection: 'Midnight Bloom', fragrance: 'Amber & Musk', description: 'Warm amber with soft musk.', shortDescription: 'Warm and velvety.', price: 1499, mrp: 1899, stock: 0, images: [image], thumbnailImage: image, featured: true,
    variants: [{ label: '200g', sku: 'AMBER-200', price: 1499, stock: 5 }, { label: '400g', sku: 'AMBER-400', price: 2499, stock: 0 }] },
  { slug: 'lavender-dusk', sku: 'LAV', name: 'Lavender Dusk', category: 'Soy Candles', collection: 'Calm', fragrance: 'Lavender', description: 'Calming lavender.', shortDescription: 'Calm evenings.', price: 899, mrp: 999, stock: 12, images: [image], thumbnailImage: image },
  { slug: 'cedar-smoke', sku: 'CEDAR', name: 'Cedar Smoke', category: 'Luxury Candles', collection: 'Midnight Bloom', fragrance: 'Cedarwood', description: 'Smoky cedar.', shortDescription: 'Woody and deep.', price: 1199, mrp: 1199, stock: 7, images: [image], thumbnailImage: image },
])
await HeroSlide.create([
  { heading: 'Autumn Rituals', subheading: 'Warm notes for cooler evenings', ctaText: 'Shop autumn', ctaUrl: '/shop', desktopImage: image, imageAlt: 'Candley Aroma emblem', sortOrder: 1 },
  { heading: 'Gift the Glow', subheading: 'Curated sets for every celebration', ctaText: 'Shop gifts', ctaUrl: '/category/luxury-candles', desktopImage: image, imageAlt: 'Candley Aroma emblem', sortOrder: 2 },
])

const server = app.listen(port, () => console.log(`E2E API listening on http://localhost:${port}`))
const shutdown = async () => {
  server.close()
  await mongoose.disconnect()
  await replSet.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
