import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Product } from '../src/models/Product.js'
import { Order } from '../src/models/Order.js'
import { api, connectTestDb, createProduct, createVariantProduct, disconnectTestDb, loginAs, resetDb } from './helpers.js'

beforeAll(connectTestDb)
afterAll(disconnectTestDb)
beforeEach(resetDb)

const productInput = (overrides: Record<string, unknown> = {}) => ({
  name: 'Lavender Dusk',
  slug: 'lavender-dusk',
  sku: 'LAV-DUSK',
  category: 'Soy Candles',
  collection: 'Calm',
  fragrance: 'Lavender',
  description: 'Soft lavender for winding down.',
  shortDescription: 'Calming lavender.',
  price: 899,
  mrp: 999,
  stock: 0,
  tags: ['calm'],
  status: 'ACTIVE',
  featured: false,
  variants: [{ label: '200g', sku: 'LAV-200', price: 899, stock: 4 }, { label: '400g', sku: 'LAV-400', price: 1499, stock: 1 }],
  ...overrides,
})

describe('public catalogue', () => {
  it('lists only published products with pagination', async () => {
    await createProduct({ status: 'ACTIVE' })
    await createProduct({ status: 'OUT_OF_STOCK', stock: 0 })
    await createProduct({ status: 'DRAFT' })
    await createProduct({ status: 'ARCHIVED' })
    const response = await api().get('/api/v1/products?limit=1&page=2')
    expect(response.status).toBe(200)
    expect(response.body.data.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 })
    const all = await api().get('/api/v1/products')
    expect(all.body.data.items.map((item: { status: string }) => item.status).sort()).toEqual(['ACTIVE', 'OUT_OF_STOCK'])
  })

  it('does not expose draft products by slug', async () => {
    const draft = await createProduct({ status: 'DRAFT' })
    expect((await api().get(`/api/v1/products/${draft.slug}`)).status).toBe(404)
  })

  it('filters by category, price and search, and sorts by price', async () => {
    await createProduct({ name: 'Rose Garden', category: 'Floral Candles', price: 300, mrp: 300, tags: ['rose'] })
    await createProduct({ name: 'Cedar Smoke', category: 'Woody Candles', price: 900, mrp: 900 })
    await createProduct({ name: 'Peony Mist', category: 'Floral Candles', price: 600, mrp: 600 })
    const floral = await api().get('/api/v1/products?category=floral-candles&sort=price_high_low')
    expect(floral.body.data.items.map((item: { name: string }) => item.name)).toEqual(['Peony Mist', 'Rose Garden'])
    const cheap = await api().get('/api/v1/products?maxPrice=500')
    expect(cheap.body.data.items).toHaveLength(1)
    const search = await api().get('/api/v1/products?q=cedar')
    expect(search.body.data.items[0].name).toBe('Cedar Smoke')
  })

  it('treats regex metacharacters and operator objects in filters as plain text', async () => {
    await createProduct()
    const regex = await api().get('/api/v1/products?category=.*')
    expect(regex.status).toBe(200)
    expect(regex.body.data.items).toHaveLength(0)
    // Express 5's simple query parser keeps "category[$ne]" as a literal key, which validation strips:
    // no operator object can reach MongoDB.
    const operator = await api().get('/api/v1/products?category[$ne]=x&status[$ne]=ACTIVE')
    expect(operator.status).toBe(200)
    expect(operator.body.data.items.every((item: { status: string }) => item.status === 'ACTIVE')).toBe(true)
  })

  it('validates pagination and sort parameters', async () => {
    expect((await api().get('/api/v1/products?limit=1000')).status).toBe(400)
    expect((await api().get('/api/v1/products?sort=$where')).status).toBe(400)
    expect((await api().get('/api/v1/products/NOT_A_SLUG!')).status).toBe(400)
  })

  it('hides inactive variants publicly', async () => {
    const product = await createVariantProduct()
    product.variants[1]!.active = false
    await product.save()
    const response = await api().get(`/api/v1/products/${product.slug}`)
    expect(response.body.data.variants).toHaveLength(1)
  })

  it('ranks best sellers from real order data and returns related products', async () => {
    const popular = await createProduct({ collection: 'Calm' })
    const other = await createProduct({ collection: 'Calm' })
    await createProduct({ collection: 'Unrelated', category: 'Other', tags: [] })
    await Order.create({ orderNumber: 'CAN-T-1', userId: popular._id, items: [{ productId: popular._id, productName: 'p', sku: 's', unitPrice: 1, quantity: 5, lineTotal: 5 }, { productId: other._id, productName: 'o', sku: 's2', unitPrice: 1, quantity: 1, lineTotal: 1 }], shippingAddress: { name: 'a', phone: '1', addressLine1: 'a', city: 'c', state: 's', postalCode: '1', country: 'IN' }, subtotal: 6, shipping: 0, total: 6, paymentMethod: 'COD', status: 'CONFIRMED' })
    const best = await api().get('/api/v1/products/best-sellers')
    expect(best.body.data.map((item: { _id: string }) => item._id)).toEqual([popular.id, other.id])
    expect(best.body.data[0].unitsSold).toBe(5)
    const related = await api().get(`/api/v1/products/${popular.slug}/related`)
    expect(related.body.data.map((item: { _id: string }) => item._id)).toContain(other.id)
    expect(related.body.data.map((item: { _id: string }) => item._id)).not.toContain(popular.id)
  })
})

describe('admin product management', () => {
  it('creates a product from the multipart format the admin UI sends', async () => {
    const { auth } = await loginAs('ADMIN')
    const response = await api().post('/api/v1/admin/products').set(auth).field('product', JSON.stringify(productInput())).field('thumbnailIndex', '0')
    expect(response.status).toBe(201)
    expect(response.body.data.variants).toHaveLength(2)
    expect(response.body.data.stock).toBe(5) // aggregate of variant stock
  })

  it('rejects malformed JSON with 400 instead of a server error', async () => {
    const { auth } = await loginAs('ADMIN')
    const response = await api().post('/api/v1/admin/products').set(auth).field('product', '{not json')
    expect(response.status).toBe(400)
  })

  it('rejects MRP below price and duplicate SKUs', async () => {
    const { auth } = await loginAs('ADMIN')
    expect((await api().post('/api/v1/admin/products').set(auth).send(productInput({ mrp: 10 }))).status).toBe(400)
    const dupInside = await api().post('/api/v1/admin/products').set(auth).send(productInput({ variants: [{ label: 'a', sku: 'X-1', price: 1, stock: 1 }, { label: 'b', sku: 'X-1', price: 1, stock: 1 }] }))
    expect(dupInside.status).toBe(409)
    expect(dupInside.body.error.code).toBe('DUPLICATE_SKU')
    await createProduct({ sku: 'TAKEN-1' })
    const dupAcross = await api().post('/api/v1/admin/products').set(auth).send(productInput({ sku: 'TAKEN-1' }))
    expect(dupAcross.status).toBe(409)
  })

  it('enforces the unique variant SKU index at the database level', async () => {
    await createProduct({ variants: [{ label: 'a', sku: 'DB-UNIQUE', price: 1, stock: 1 }] })
    await expect(createProduct({ variants: [{ label: 'b', sku: 'DB-UNIQUE', price: 1, stock: 1 }] })).rejects.toMatchObject({ code: 11000 })
  })

  it('keeps variant ids stable when the admin UI re-saves variants without ids or SKUs', async () => {
    const { auth } = await loginAs('ADMIN')
    const created = await api().post('/api/v1/admin/products').set(auth).send(productInput())
    const ids = created.body.data.variants.map((variant: { _id: string }) => variant._id)
    // Mirrors AdminProductsPage, which sends variants with an empty sku and no _id.
    const updated = await api().patch(`/api/v1/admin/products/${created.body.data._id}`).set(auth).field('product', JSON.stringify(productInput({ variants: [{ label: '200g', sku: '', price: 950, stock: 7 }, { label: '400g', sku: '', price: 1500, stock: 1 }] })))
    expect(updated.status).toBe(200)
    expect(updated.body.data.variants.map((variant: { _id: string }) => variant._id)).toEqual(ids)
    expect(updated.body.data.variants[0]).toMatchObject({ sku: 'LAV-200', price: 950, stock: 7 })
  })

  it('updates inventory atomically and refuses to go negative', async () => {
    const { auth } = await loginAs('ADMIN')
    const product = await createVariantProduct()
    const variantId = String(product.variants[0]!._id)
    const adjust = await api().patch(`/api/v1/admin/products/${product.id}/inventory`).set(auth).send({ variantId, delta: 3 })
    expect(adjust.status).toBe(200)
    expect(adjust.body.data.variants[0].stock).toBe(8)
    expect(adjust.body.data.stock).toBe(10)
    expect((await api().patch(`/api/v1/admin/products/${product.id}/inventory`).set(auth).send({ variantId, delta: -100 })).status).toBe(422)
    expect((await api().patch(`/api/v1/admin/products/${product.id}/inventory`).set(auth).send({ stock: 3 })).status).toBe(422)
  })

  it('publishes and archives products', async () => {
    const { auth } = await loginAs('ADMIN')
    const product = await createProduct({ status: 'DRAFT' })
    expect((await api().get(`/api/v1/products/${product.slug}`)).status).toBe(404)
    await api().patch(`/api/v1/admin/products/${product.id}/status`).set(auth).send({ status: 'ACTIVE' })
    expect((await api().get(`/api/v1/products/${product.slug}`)).status).toBe(200)
    await api().patch(`/api/v1/admin/products/${product.id}/status`).set(auth).send({ status: 'ARCHIVED' })
    expect((await api().get(`/api/v1/products/${product.slug}`)).status).toBe(404)
  })

  it('archives instead of deleting products referenced by orders', async () => {
    const { auth, user } = await loginAs('ADMIN')
    const ordered = await createProduct()
    const unused = await createProduct()
    await Order.create({ orderNumber: 'CAN-T-2', userId: user._id, items: [{ productId: ordered._id, productName: 'p', sku: 's', unitPrice: 1, quantity: 1, lineTotal: 1 }], shippingAddress: { name: 'a', phone: '1', addressLine1: 'a', city: 'c', state: 's', postalCode: '1', country: 'IN' }, subtotal: 1, shipping: 0, total: 1, paymentMethod: 'COD' })
    const archived = await api().delete(`/api/v1/admin/products/${ordered.id}`).set(auth)
    expect(archived.body.data).toMatchObject({ deleted: false, archived: true })
    expect((await Product.findById(ordered.id).lean())!.status).toBe('ARCHIVED')
    const deleted = await api().delete(`/api/v1/admin/products/${unused.id}`).set(auth)
    expect(deleted.body.data.deleted).toBe(true)
    expect(await Product.findById(unused.id)).toBeNull()
  })

  it('rejects invalid identifiers', async () => {
    const { auth } = await loginAs('ADMIN')
    expect((await api().get('/api/v1/admin/products/not-an-id').set(auth)).status).toBe(400)
    expect((await api().get('/api/v1/admin/products/64b7f0f0f0f0f0f0f0f0f0f0').set(auth)).status).toBe(404)
  })

  it('escapes admin search input', async () => {
    const { auth } = await loginAs('ADMIN')
    await createProduct()
    const response = await api().get('/api/v1/admin/products?search=(a%2B)%2B$').set(auth)
    expect(response.status).toBe(200)
    expect(response.body.data.items).toHaveLength(0)
  })

  it('rejects uploads whose content is not really an image', async () => {
    const { auth } = await loginAs('ADMIN')
    const response = await api().post('/api/v1/admin/products').set(auth)
      .field('product', JSON.stringify(productInput()))
      .attach('images', Buffer.from('<script>alert(1)</script>'.padEnd(64, ' ')), { filename: 'evil.png', contentType: 'image/png' })
    expect(response.status).toBe(415)
  })
})

describe('authorization', () => {
  it('blocks customers and anonymous users from every admin product operation', async () => {
    const { auth } = await loginAs('CUSTOMER')
    const product = await createProduct()
    const attempts = [
      api().get('/api/v1/admin/products').set(auth),
      api().post('/api/v1/admin/products').set(auth).send(productInput()),
      api().patch(`/api/v1/admin/products/${product.id}`).set(auth).send({ price: 1 }),
      api().patch(`/api/v1/admin/products/${product.id}/inventory`).set(auth).send({ stock: 999 }),
      api().patch(`/api/v1/admin/products/${product.id}/status`).set(auth).send({ status: 'ARCHIVED' }),
      api().delete(`/api/v1/admin/products/${product.id}`).set(auth),
    ]
    for (const response of await Promise.all(attempts)) expect(response.status).toBe(403)
    expect((await api().patch(`/api/v1/admin/products/${product.id}`).send({ price: 1 })).status).toBe(401)
    const stored = await Product.findById(product.id).lean()
    expect(stored).toMatchObject({ price: 500, stock: 10, status: 'ACTIVE' })
  })
})
