import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Cart } from '../src/models/Cart.js'
import { Product } from '../src/models/Product.js'
import { Wishlist } from '../src/models/Wishlist.js'
import { api, connectTestDb, createProduct, createVariantProduct, disconnectTestDb, loginAs, resetDb } from './helpers.js'

beforeAll(connectTestDb)
afterAll(disconnectTestDb)
beforeEach(resetDb)

describe('cart', () => {
  it('rejects guests', async () => {
    expect((await api().get('/api/v1/cart')).status).toBe(401)
    expect((await api().post('/api/v1/cart/items').send({ productId: '64b7f0f0f0f0f0f0f0f0f0f0', quantity: 1 })).status).toBe(401)
  })

  it('merges repeated adds into one line and returns server prices', async () => {
    const { auth, user } = await loginAs()
    const product = await createProduct({ price: 450, mrp: 500 })
    await api().post('/api/v1/cart/items').set(auth).send({ productId: product.id, quantity: 1, price: 1 })
    const response = await api().post('/api/v1/cart/items').set(auth).send({ productId: product.id, quantity: 2 })
    expect(response.status).toBe(200)
    expect(response.body.data.items).toHaveLength(1)
    expect(response.body.data.items[0]).toMatchObject({ quantity: 3, unitPrice: 450, lineTotal: 1350, available: true })
    expect(response.body.data.items[0].productId._id).toBe(product.id) // existing contract: populated product
    expect(response.body.data.subtotal).toBe(1350)
    expect((await Cart.findOne({ userId: user.id }).lean())!.items).toHaveLength(1)
  })

  it('keeps different variants of one product as separate lines priced per variant', async () => {
    const { auth } = await loginAs()
    const product = await createVariantProduct()
    const [small, large] = product.variants.map((variant) => String(variant._id))
    await api().post('/api/v1/cart/items').set(auth).send({ productId: product.id, variantId: small, quantity: 1 })
    const response = await api().post('/api/v1/cart/items').set(auth).send({ productId: product.id, variantId: large, quantity: 1 })
    expect(response.body.data.items.map((item: { unitPrice: number }) => item.unitPrice)).toEqual([800, 1400])
    expect((await api().patch(`/api/v1/cart/items/${product.id}`).set(auth).send({ quantity: 2 })).status).toBe(422)
    const updated = await api().patch(`/api/v1/cart/items/${product.id}?variantId=${small}`).set(auth).send({ quantity: 2 })
    expect(updated.body.data.items[0].quantity).toBe(2)
    const removed = await api().delete(`/api/v1/cart/items/${product.id}?variantId=${large}`).set(auth)
    expect(removed.body.data.items).toHaveLength(1)
  })

  it('requires a variant choice when a product has several variants and rejects foreign variant ids', async () => {
    const { auth } = await loginAs()
    const product = await createVariantProduct()
    const other = await createVariantProduct()
    expect((await api().post('/api/v1/cart/items').set(auth).send({ productId: product.id, quantity: 1 })).body.error.code).toBe('VARIANT_REQUIRED')
    const foreign = await api().post('/api/v1/cart/items').set(auth).send({ productId: product.id, variantId: String(other.variants[0]!._id), quantity: 1 })
    expect(foreign.body.error.code).toBe('VARIANT_UNAVAILABLE')
  })

  it('accepts the storefront "default" variant id for products without variants', async () => {
    const { auth } = await loginAs()
    const product = await createProduct()
    const response = await api().post('/api/v1/cart/items').set(auth).send({ productId: product.id, variantId: 'default', quantity: 1 })
    expect(response.status).toBe(200)
    expect(response.body.data.items[0].variantId).toBeUndefined()
  })

  it('enforces stock, per-item quantity limits and publication status', async () => {
    const { auth } = await loginAs()
    const product = await createProduct({ stock: 3 })
    const draft = await createProduct({ status: 'DRAFT' })
    const soldOut = await createProduct({ stock: 0 })
    expect((await api().post('/api/v1/cart/items').set(auth).send({ productId: product.id, quantity: 4 })).status).toBe(409)
    await api().post('/api/v1/cart/items').set(auth).send({ productId: product.id, quantity: 3 })
    expect((await api().post('/api/v1/cart/items').set(auth).send({ productId: product.id, quantity: 1 })).status).toBe(409)
    expect((await api().post('/api/v1/cart/items').set(auth).send({ productId: draft.id, quantity: 1 })).status).toBe(404)
    expect((await api().post('/api/v1/cart/items').set(auth).send({ productId: soldOut.id, quantity: 1 })).body.error.code).toBe('OUT_OF_STOCK')
    const big = await createProduct({ stock: 500 })
    expect((await api().post('/api/v1/cart/items').set(auth).send({ productId: big.id, quantity: 11 })).body.error.code).toBe('QUANTITY_LIMIT')
  })

  it('reflects price changes and unavailability on read', async () => {
    const { auth } = await loginAs()
    const product = await createProduct({ price: 500 })
    await api().post('/api/v1/cart/items').set(auth).send({ productId: product.id, quantity: 2 })
    await Product.updateOne({ _id: product.id }, { price: 650, mrp: 700 })
    expect((await api().get('/api/v1/cart').set(auth)).body.data.items[0]).toMatchObject({ unitPrice: 650, lineTotal: 1300 })
    await Product.updateOne({ _id: product.id }, { status: 'ARCHIVED' })
    const archived = (await api().get('/api/v1/cart').set(auth)).body.data
    expect(archived.items[0]).toMatchObject({ available: false, issue: 'PRODUCT_UNAVAILABLE', lineTotal: 0 })
    expect(archived.subtotal).toBe(0)
    expect(archived.hasIssues).toBe(true)
  })

  it('handles concurrent adds without losing quantity', async () => {
    const { auth } = await loginAs()
    const product = await createProduct({ stock: 50 })
    await Promise.all(Array.from({ length: 5 }, () => api().post('/api/v1/cart/items').set(auth).send({ productId: product.id, quantity: 1 })))
    const cart = (await api().get('/api/v1/cart').set(auth)).body.data
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0].quantity).toBe(5)
  })

  it('isolates carts between users and ignores client-supplied user ids', async () => {
    const alice = await loginAs()
    const bob = await loginAs()
    const product = await createProduct()
    await api().post('/api/v1/cart/items').set(alice.auth).send({ productId: product.id, quantity: 2, userId: bob.user.id })
    expect((await api().get('/api/v1/cart').set(bob.auth)).body.data.items).toHaveLength(0)
    expect((await api().get('/api/v1/cart').set(alice.auth)).body.data.items).toHaveLength(1)
    await api().delete(`/api/v1/cart/items/${product.id}`).set(bob.auth)
    expect((await api().get('/api/v1/cart').set(alice.auth)).body.data.items).toHaveLength(1)
  })

  it('rejects operator injection in JSON bodies', async () => {
    const { auth } = await loginAs()
    expect((await api().post('/api/v1/cart/items').set(auth).send({ productId: { $ne: null }, quantity: 1 })).status).toBe(400)
  })
})

describe('wishlist', () => {
  it('rejects guests', async () => {
    expect((await api().get('/api/v1/wishlist')).status).toBe(401)
  })

  it('adds without duplicates, removes, clears and persists', async () => {
    const { auth, user } = await loginAs()
    const product = await createProduct()
    await api().post('/api/v1/wishlist').set(auth).send({ productId: product.id })
    const twice = await api().post('/api/v1/wishlist').set(auth).send({ productId: product.id })
    expect(twice.body.data.productIds).toHaveLength(1)
    expect(twice.body.data.productIds[0]._id).toBe(product.id)
    expect((await Wishlist.findOne({ userId: user.id }).lean())!.productIds).toHaveLength(1)
    expect((await api().delete(`/api/v1/wishlist/${product.id}`).set(auth)).body.data.productIds).toHaveLength(0)
    await api().post('/api/v1/wishlist').set(auth).send({ productId: product.id })
    expect((await api().delete('/api/v1/wishlist').set(auth)).body.data.productIds).toHaveLength(0)
  })

  it('validates product ids and hides archived products', async () => {
    const { auth } = await loginAs()
    expect((await api().post('/api/v1/wishlist').set(auth).send({ productId: 'nope' })).status).toBe(400)
    expect((await api().post('/api/v1/wishlist').set(auth).send({ productId: '64b7f0f0f0f0f0f0f0f0f0f0' })).status).toBe(404)
    const product = await createProduct()
    await api().post('/api/v1/wishlist').set(auth).send({ productId: product.id })
    await Product.updateOne({ _id: product.id }, { status: 'ARCHIVED' })
    expect((await api().get('/api/v1/wishlist').set(auth)).body.data.productIds).toHaveLength(0)
  })

  it('isolates wishlists between users', async () => {
    const alice = await loginAs()
    const bob = await loginAs()
    const product = await createProduct()
    await api().post('/api/v1/wishlist').set(alice.auth).send({ productId: product.id })
    expect((await api().get('/api/v1/wishlist').set(bob.auth)).body.data.productIds).toHaveLength(0)
  })
})
