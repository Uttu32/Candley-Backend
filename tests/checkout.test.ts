import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Cart } from '../src/models/Cart.js'
import { Coupon } from '../src/models/Coupon.js'
import { Order } from '../src/models/Order.js'
import { Product } from '../src/models/Product.js'
import { StoreSettings } from '../src/models/StoreSettings.js'
import { setTransactionsSupported } from '../src/services/transaction.js'
import { address, api, connectTestDb, createProduct, createVariantProduct, disconnectTestDb, loginAs, resetDb } from './helpers.js'

beforeAll(connectTestDb)
afterAll(disconnectTestDb)
beforeEach(resetDb)
afterEach(() => setTransactionsSupported(undefined))

const addToCart = (auth: Record<string, string>, productId: string, quantity: number, variantId?: string) =>
  api().post('/api/v1/cart/items').set(auth).send({ productId, quantity, variantId })

const checkout = (auth: Record<string, string>, body: Record<string, unknown> = {}) =>
  api().post('/api/v1/orders').set(auth).send({ shippingAddress: address, paymentMethod: 'COD', ...body })

for (const mode of ['transactions', 'compensation'] as const) {
  describe(`checkout (${mode})`, () => {
    beforeEach(() => setTransactionsSupported(mode === 'transactions'))

    it('prices the order on the server, ignoring client-supplied amounts, and deducts stock', async () => {
      const { auth, user } = await loginAs()
      const product = await createVariantProduct()
      const variant = product.variants[1]! // 400g @ 1400, stock 2
      await addToCart(auth, product.id, 2, String(variant._id))
      const response = await checkout(auth, { total: 1, subtotal: 1, discount: 999, paymentStatus: 'PAID', status: 'DELIVERED', items: [{ unitPrice: 1 }] })
      expect(response.status).toBe(201)
      expect(response.body.data).toMatchObject({ subtotal: 2800, shipping: 0, discount: 0, total: 2800, paymentStatus: 'PENDING', status: 'CONFIRMED', paymentMethod: 'COD' })
      expect(response.body.data.items[0]).toMatchObject({ sku: variant.sku, variantLabel: '400g', unitPrice: 1400, quantity: 2, lineTotal: 2800, productName: product.name })
      expect(response.body.data).not.toHaveProperty('checkoutFingerprint')
      const stored = await Product.findById(product.id).lean()
      expect(stored!.variants[1]!.stock).toBe(0)
      expect(stored!.variants[0]!.stock).toBe(5)
      expect(stored!.stock).toBe(5)
      expect((await Cart.findOne({ userId: user.id }).lean())!.items).toHaveLength(0)
    })

    it('applies shipping below the free-shipping threshold from store settings', async () => {
      const { auth } = await loginAs()
      await StoreSettings.updateOne({}, { shippingFee: 49, freeShippingThreshold: 2000 }, { upsert: true })
      const product = await createProduct({ price: 500 })
      await addToCart(auth, product.id, 1)
      expect((await checkout(auth)).body.data).toMatchObject({ subtotal: 500, shipping: 49, total: 549 })
    })

    it('rejects checkout when stock ran out after the item was carted, leaving everything unchanged', async () => {
      const { auth, user } = await loginAs()
      const a = await createProduct({ stock: 5 })
      const b = await createProduct({ stock: 5 })
      await addToCart(auth, a.id, 2)
      await addToCart(auth, b.id, 3)
      await Product.updateOne({ _id: b.id }, { stock: 1 })
      const response = await checkout(auth)
      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('CART_ITEMS_UNAVAILABLE')
      expect(response.body.error.details[0]).toMatchObject({ productId: b.id, issue: 'INSUFFICIENT_STOCK' })
      expect((await Product.findById(a.id).lean())!.stock).toBe(5)
      expect(await Order.countDocuments()).toBe(0)
      expect((await Cart.findOne({ userId: user.id }).lean())!.items).toHaveLength(2)
    })

    it('never oversells under concurrent checkouts of the last units', async () => {
      const product = await createProduct({ stock: 3 })
      const buyers = await Promise.all(Array.from({ length: 5 }, () => loginAs()))
      for (const buyer of buyers) await addToCart(buyer.auth, product.id, 1)
      await Product.updateOne({ _id: product.id }, { stock: 2 })
      const results = await Promise.all(buyers.map((buyer) => checkout(buyer.auth)))
      const created = results.filter((response) => response.status === 201)
      expect(created).toHaveLength(2)
      expect(results.filter((response) => response.status === 409)).toHaveLength(3)
      expect((await Product.findById(product.id).lean())!.stock).toBe(0)
      expect(await Order.countDocuments()).toBe(2)
    })

    it('rolls back earlier stock deductions when a later line fails mid-checkout', async () => {
      const { auth } = await loginAs()
      const a = await createProduct({ stock: 5 })
      const b = await createProduct({ stock: 5 })
      await addToCart(auth, a.id, 2)
      await addToCart(auth, b.id, 2)
      // Simulate a concurrent purchase between validation and reservation: b's stock vanishes after pricing.
      const original = Product.updateOne.bind(Product)
      let calls = 0
      ;(Product as unknown as { updateOne: typeof Product.updateOne }).updateOne = ((...args: Parameters<typeof Product.updateOne>) => {
        calls += 1
        if (calls === 2) return original({ _id: b._id }, { $set: { stock: 0 } }).then(() => original(...args))
        return original(...args)
      }) as typeof Product.updateOne
      try {
        const response = await checkout(auth)
        expect(response.status).toBe(409)
        expect(response.body.error.code).toBe('INSUFFICIENT_STOCK')
      } finally {
        ;(Product as unknown as { updateOne: typeof Product.updateOne }).updateOne = original
      }
      expect((await Product.findById(a.id).lean())!.stock).toBe(5)
      expect(await Order.countDocuments()).toBe(0)
    })
  })
}

describe('checkout validation and duplicates', () => {
  it('rejects an empty cart, invalid addresses and unknown payment methods', async () => {
    const { auth } = await loginAs()
    expect((await checkout(auth)).body.error.code).toBe('CART_EMPTY')
    const product = await createProduct()
    await addToCart(auth, product.id, 1)
    expect((await checkout(auth, { shippingAddress: { ...address, postalCode: '<script>' } })).status).toBe(400)
    expect((await checkout(auth, { paymentMethod: 'BITCOIN' })).status).toBe(400)
    expect((await api().post('/api/v1/orders').set(auth).send({ paymentMethod: 'COD' })).status).toBe(400)
  })

  it('rejects products that became unpublished', async () => {
    const { auth } = await loginAs()
    const product = await createProduct()
    await addToCart(auth, product.id, 1)
    await Product.updateOne({ _id: product.id }, { status: 'DRAFT' })
    const response = await checkout(auth)
    expect(response.status).toBe(409)
    expect(response.body.error.details[0].issue).toBe('PRODUCT_UNAVAILABLE')
  })

  it('returns the same order for a repeated idempotency key', async () => {
    const { auth } = await loginAs()
    const product = await createProduct()
    await addToCart(auth, product.id, 1)
    const first = await api().post('/api/v1/orders').set(auth).set('Idempotency-Key', 'checkout-key-123').send({ shippingAddress: address, paymentMethod: 'COD' })
    const second = await api().post('/api/v1/orders').set(auth).set('Idempotency-Key', 'checkout-key-123').send({ shippingAddress: address, paymentMethod: 'COD' })
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(second.body.data._id).toBe(first.body.data._id)
    expect(await Order.countDocuments()).toBe(1)
    expect((await Product.findById(product.id).lean())!.stock).toBe(9)
  })

  it('creates only one COD order from a double-submitted cart', async () => {
    const { auth } = await loginAs()
    const product = await createProduct()
    await addToCart(auth, product.id, 1)
    const [a, b] = await Promise.all([checkout(auth), checkout(auth)])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect([a, b].find((response) => response.status === 409)!.body.error.code).toBe('CHECKOUT_CONFLICT')
    expect(await Order.countDocuments()).toBe(1)
    expect((await Product.findById(product.id).lean())!.stock).toBe(9)
  })

  it('uses a saved address by id', async () => {
    const { auth } = await loginAs()
    const saved = await api().post('/api/v1/account/addresses').set(auth).send(address)
    const product = await createProduct()
    await addToCart(auth, product.id, 1)
    const response = await api().post('/api/v1/orders').set(auth).send({ addressId: saved.body.data[0]._id, paymentMethod: 'COD' })
    expect(response.status).toBe(201)
    expect(response.body.data.shippingAddress.city).toBe('Bengaluru')
  })
})

describe('cash on delivery rules', () => {
  it('rejects COD when disabled or above the configured limit', async () => {
    const { auth } = await loginAs()
    const product = await createProduct({ price: 1500, mrp: 1500 })
    await addToCart(auth, product.id, 1)
    await StoreSettings.updateOne({}, { codEnabled: false }, { upsert: true })
    expect(await StoreSettings.countDocuments()).toBe(1)
    expect((await checkout(auth)).body.error.code).toBe('COD_UNAVAILABLE')
    await StoreSettings.updateOne({}, { codEnabled: true, codMaxOrderValue: 1000 })
    expect((await checkout(auth)).body.error.code).toBe('COD_UNAVAILABLE')
    expect((await Product.findById(product.id).lean())!.stock).toBe(10)
  })
})

describe('coupons', () => {
  it('applies a valid percentage coupon with a cap and counts its use', async () => {
    const { auth } = await loginAs()
    await Coupon.create({ code: 'GLOW20', discountType: 'PERCENT', amount: 20, maxDiscount: 150, minOrderValue: 500 })
    const product = await createProduct({ price: 1000, mrp: 1000 })
    await addToCart(auth, product.id, 1)
    const response = await checkout(auth, { couponCode: 'glow20', discount: 900 })
    expect(response.status).toBe(201)
    expect(response.body.data).toMatchObject({ subtotal: 1000, discount: 150, shipping: 99, total: 949, couponCode: 'GLOW20' })
    expect((await Coupon.findOne({ code: 'GLOW20' }).lean())!.usedCount).toBe(1)
  })

  it('rejects expired, inactive, exhausted and per-customer-limited coupons', async () => {
    const { auth } = await loginAs()
    const product = await createProduct({ price: 1000, mrp: 1000, stock: 50 })
    await addToCart(auth, product.id, 1)
    await Coupon.create([
      { code: 'OLD', discountType: 'FIXED', amount: 100, endsAt: new Date(Date.now() - 1000) },
      { code: 'OFF', discountType: 'FIXED', amount: 100, active: false },
      { code: 'GONE', discountType: 'FIXED', amount: 100, usageLimit: 1, usedCount: 1 },
      { code: 'ONCE', discountType: 'FIXED', amount: 100, perCustomerLimit: 1 },
      { code: 'BIGSPEND', discountType: 'FIXED', amount: 100, minOrderValue: 5000 },
    ])
    for (const code of ['OLD', 'OFF', 'GONE', 'BIGSPEND', 'NOPE']) {
      const response = await checkout(auth, { couponCode: code })
      expect(response.status, code).toBe(422)
      expect(response.body.error.code).toBe('COUPON_INVALID')
    }
    expect((await checkout(auth, { couponCode: 'ONCE' })).status).toBe(201)
    await addToCart(auth, product.id, 1)
    expect((await checkout(auth, { couponCode: 'ONCE' })).body.error.code).toBe('COUPON_INVALID')
  })
})

describe('order access and lifecycle', () => {
  it('only shows customers their own orders', async () => {
    const alice = await loginAs()
    const bob = await loginAs()
    const product = await createProduct()
    await addToCart(alice.auth, product.id, 1)
    const order = (await checkout(alice.auth)).body.data
    expect((await api().get('/api/v1/orders').set(alice.auth)).body.data).toHaveLength(1)
    expect((await api().get('/api/v1/orders').set(bob.auth)).body.data).toHaveLength(0)
    expect((await api().get(`/api/v1/orders/${order._id}`).set(bob.auth)).status).toBe(404)
    expect((await api().post(`/api/v1/orders/${order._id}/cancel`).set(bob.auth)).status).toBe(404)
  })

  it('lets a customer cancel a confirmed order, restoring stock and coupon use exactly once', async () => {
    const { auth } = await loginAs()
    await Coupon.create({ code: 'TEN', discountType: 'FIXED', amount: 10 })
    const product = await createProduct({ stock: 4 })
    await addToCart(auth, product.id, 3)
    const order = (await checkout(auth, { couponCode: 'TEN' })).body.data
    expect((await Product.findById(product.id).lean())!.stock).toBe(1)
    const [first, second] = await Promise.all([
      api().post(`/api/v1/orders/${order._id}/cancel`).set(auth).send({ reason: 'Changed my mind' }),
      api().post(`/api/v1/orders/${order._id}/cancel`).set(auth).send({}),
    ])
    expect([first.status, second.status].sort()).toEqual([200, 409])
    expect((await Product.findById(product.id).lean())!.stock).toBe(4)
    expect((await Coupon.findOne({ code: 'TEN' }).lean())!.usedCount).toBe(0)
  })

  it('enforces the admin status workflow and blocks customers from changing status', async () => {
    const customer = await loginAs()
    const admin = await loginAs('ADMIN')
    const product = await createProduct()
    await addToCart(customer.auth, product.id, 1)
    const order = (await checkout(customer.auth)).body.data
    expect((await api().patch(`/api/v1/admin/orders/${order._id}/status`).set(customer.auth).send({ status: 'DELIVERED' })).status).toBe(403)

    expect((await api().patch(`/api/v1/admin/orders/${order._id}/status`).set(admin.auth).send({ status: 'DELIVERED' })).status).toBe(409)
    expect((await api().post(`/api/v1/admin/orders/${order._id}/cod-collected`).set(admin.auth)).status).toBe(409)
    for (const status of ['PROCESSING', 'SHIPPED']) {
      expect((await api().patch(`/api/v1/admin/orders/${order._id}/status`).set(admin.auth).send({ status })).status).toBe(200)
    }
    expect((await api().post(`/api/v1/orders/${order._id}/cancel`).set(customer.auth)).status).toBe(409)
    expect((await api().patch(`/api/v1/admin/orders/${order._id}/status`).set(admin.auth).send({ status: 'DELIVERED' })).status).toBe(200)
    const collected = await api().post(`/api/v1/admin/orders/${order._id}/cod-collected`).set(admin.auth)
    expect(collected.status).toBe(200)
    expect(collected.body.data.paymentStatus).toBe('PAID')

    const detail = await api().get(`/api/v1/admin/orders/${order._id}`).set(admin.auth)
    expect(detail.body.data.statusHistory.map((entry: { status: string }) => entry.status)).toEqual(['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'DELIVERED'])
    const listing = await api().get('/api/v1/admin/orders?status=DELIVERED').set(admin.auth)
    expect(listing.body.data.pagination.total).toBe(1)
  })

  it('keeps historical order data when the product is later edited', async () => {
    const { auth } = await loginAs()
    const product = await createProduct({ name: 'Original Name', price: 500 })
    await addToCart(auth, product.id, 1)
    const order = (await checkout(auth)).body.data
    await Product.updateOne({ _id: product.id }, { name: 'Renamed', price: 9999, mrp: 9999 })
    const stored = (await api().get(`/api/v1/orders/${order._id}`).set(auth)).body.data
    expect(stored.items[0]).toMatchObject({ productName: 'Original Name', unitPrice: 500 })
  })
})

describe('quote and checkout options', () => {
  it('returns the same server totals that checkout will charge, and reports coupon errors without failing', async () => {
    const { auth } = await loginAs()
    await Coupon.create({ code: 'FLAT100', discountType: 'FIXED', amount: 100 })
    const product = await createProduct({ price: 400, mrp: 400 })
    await addToCart(auth, product.id, 2)
    const quote = await api().post('/api/v1/orders/quote').set(auth).send({ couponCode: 'FLAT100' })
    expect(quote.status).toBe(200)
    expect(quote.body.data).toMatchObject({ subtotal: 800, discount: 100, shipping: 99, total: 799, couponCode: 'FLAT100', couponError: null })
    expect(quote.body.data.paymentMethods.cod.available).toBe(true)
    const bad = await api().post('/api/v1/orders/quote').set(auth).send({ couponCode: 'NOPE' })
    expect(bad.body.data).toMatchObject({ discount: 0, total: 899, couponCode: null })
    expect(bad.body.data.couponError).toMatch(/not valid/)
    const order = await checkout(auth, { couponCode: 'FLAT100' })
    expect(order.body.data.total).toBe(quote.body.data.total)
    expect(await Order.countDocuments()).toBe(1)
  })

  it('exposes public checkout options without secrets', async () => {
    await StoreSettings.updateOne({}, { codEnabled: false }, { upsert: true })
    const response = await api().get('/api/v1/cms/checkout-options')
    expect(response.body.data).toMatchObject({ codEnabled: false, razorpayEnabled: true, shippingFee: 99 })
    expect(JSON.stringify(response.body)).not.toContain(process.env.RAZORPAY_KEY_SECRET!)
  })

  it('requires authentication for quotes', async () => {
    expect((await api().post('/api/v1/orders/quote').send({})).status).toBe(401)
  })
})
