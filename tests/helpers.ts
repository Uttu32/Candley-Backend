import mongoose from 'mongoose'
import argon2 from 'argon2'
import request from 'supertest'
import { app } from '../src/app.js'
import { env } from '../src/config/env.js'
import { User } from '../src/models/User.js'
import { Product } from '../src/models/Product.js'
import { mailOutbox } from '../src/services/mailer.js'

export const api = () => request(app)

export const connectTestDb = async () => {
  const host = new URL(env.MONGO_URI).hostname
  if (env.NODE_ENV !== 'test' || !['127.0.0.1', 'localhost'].includes(host)) {
    throw new Error('Refusing to run tests against a non-local database')
  }
  await mongoose.connect(env.MONGO_URI)
  // Build every declared index (unique constraints included) before tests rely on them.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()))
}

export const resetDb = async () => {
  const collections = await mongoose.connection.db!.collections()
  await Promise.all(collections.map((collection) => collection.deleteMany({})))
  mailOutbox?.splice(0)
}

export const disconnectTestDb = async () => {
  await mongoose.connection.dropDatabase()
  await mongoose.disconnect()
}

let counter = 0
const unique = () => `${Date.now().toString(36)}${(counter += 1)}`

export const password = 'CorrectHorse!42'

export const createUser = async (overrides: { role?: 'CUSTOMER' | 'ADMIN' | 'SUPER_ADMIN'; status?: 'ACTIVE' | 'BLOCKED' | 'SUSPENDED' | 'DELETED'; email?: string } = {}) => {
  const email = overrides.email ?? `user-${unique()}@example.test`
  const user = await User.create({ name: 'Test User', email, passwordHash: await argon2.hash(password), role: overrides.role ?? 'CUSTOMER', status: overrides.status ?? 'ACTIVE' })
  return user
}

/** Creates a user and signs in through the real login endpoint. */
export const loginAs = async (role: 'CUSTOMER' | 'ADMIN' | 'SUPER_ADMIN' = 'CUSTOMER') => {
  const user = await createUser({ role })
  const response = await api().post('/api/v1/auth/login').send({ email: user.email, password })
  if (response.status !== 200) throw new Error(`Login failed: ${response.status} ${JSON.stringify(response.body)}`)
  return { user, token: response.body.data.accessToken as string, cookie: response.headers['set-cookie'] as unknown as string[], auth: { Authorization: `Bearer ${response.body.data.accessToken}` } }
}

export const createProduct = async (overrides: Record<string, unknown> = {}) => {
  const id = unique()
  return Product.create({
    slug: `test-candle-${id}`,
    sku: `SKU-${id}`,
    name: `Test Candle ${id}`,
    category: 'Luxury Candles',
    collection: 'Midnight Bloom',
    fragrance: 'Vanilla',
    description: 'A test candle description.',
    shortDescription: 'Test candle.',
    price: 500,
    mrp: 700,
    stock: 10,
    tags: ['warm'],
    images: ['/images/test.png'],
    thumbnailImage: '/images/test.png',
    status: 'ACTIVE',
    ...overrides,
  })
}

export const createVariantProduct = async (overrides: Record<string, unknown> = {}) => {
  const id = unique()
  return createProduct({
    variants: [
      { label: '200g', sku: `V200-${id}`, price: 800, stock: 5 },
      { label: '400g', sku: `V400-${id}`, price: 1400, stock: 2 },
    ],
    ...overrides,
  })
}

export const address = {
  name: 'Asha Rao',
  phone: '+91 98765 43210',
  addressLine1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
  country: 'India',
}
