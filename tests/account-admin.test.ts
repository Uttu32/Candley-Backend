import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { User } from '../src/models/User.js'
import { address, api, connectTestDb, createProduct, disconnectTestDb, loginAs, resetDb } from './helpers.js'

beforeAll(connectTestDb)
afterAll(disconnectTestDb)
beforeEach(resetDb)

describe('addresses', () => {
  it('creates, edits, switches default and removes addresses for the signed-in user only', async () => {
    const { auth, user } = await loginAs()
    const first = await api().post('/api/v1/account/addresses').set(auth).send(address)
    expect(first.status).toBe(201)
    expect(first.body.data[0].isDefault).toBe(true)
    const second = await api().post('/api/v1/account/addresses').set(auth).send({ ...address, label: 'Office', city: 'Mysuru', isDefault: true })
    expect(second.body.data.map((entry: { isDefault: boolean }) => entry.isDefault)).toEqual([false, true])
    const [home, office] = second.body.data
    const edited = await api().patch(`/api/v1/account/addresses/${home._id}`).set(auth).send({ city: 'Hubballi' })
    expect(edited.body.data[0].city).toBe('Hubballi')
    const removed = await api().delete(`/api/v1/account/addresses/${office._id}`).set(auth)
    expect(removed.body.data).toHaveLength(1)
    expect(removed.body.data[0].isDefault).toBe(true)
    expect((await User.findById(user.id).lean())!.addresses).toHaveLength(1)

    const intruder = await loginAs()
    expect((await api().patch(`/api/v1/account/addresses/${home._id}`).set(intruder.auth).send({ city: 'Chennai' })).status).toBe(404)
    expect((await api().get('/api/v1/account/addresses').set(intruder.auth)).body.data).toHaveLength(0)
  })

  it('validates address fields', async () => {
    const { auth } = await loginAs()
    expect((await api().post('/api/v1/account/addresses').set(auth).send({ ...address, phone: 'call me' })).status).toBe(400)
    expect((await api().post('/api/v1/account/addresses').set(auth).send({ ...address, city: '' })).status).toBe(400)
  })
})

describe('admin dashboard', () => {
  it('computes figures from real orders, products and customers', async () => {
    const admin = await loginAs('ADMIN')
    const buyer = await loginAs()
    await loginAs() // a second customer with no orders
    await createProduct({ stock: 0 })
    await createProduct({ stock: 3 })
    const product = await createProduct({ price: 1000, mrp: 1000 })
    await api().post('/api/v1/cart/items').set(buyer.auth).send({ productId: product.id, quantity: 2 })
    const order = (await api().post('/api/v1/orders').set(buyer.auth).send({ shippingAddress: address, paymentMethod: 'COD' })).body.data
    for (const status of ['PROCESSING', 'SHIPPED', 'DELIVERED']) await api().patch(`/api/v1/admin/orders/${order._id}/status`).set(admin.auth).send({ status })
    await api().post(`/api/v1/admin/orders/${order._id}/cod-collected`).set(admin.auth)

    const response = await api().get('/api/v1/admin/dashboard').set(admin.auth)
    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({ totalSales: 2000, totalOrders: 1, paidOrders: 1, totalCustomers: 2, totalProducts: 3, outOfStockProducts: 1, lowStockProducts: 1, averageOrderValue: 2000 })
    expect(response.body.data.topProducts[0]).toMatchObject({ productId: product.id, units: 2, revenue: 2000 })
    expect(response.body.data.revenueSeries).toHaveLength(1)
    expect(response.body.data).toMatchObject({ bookedSales: 2000, bookedOrders: 1, previous: null, seriesUnit: 'month' })
    expect(response.body.data.paymentMethods).toEqual([{ method: 'COD', count: 1, amount: 2000 }])
    expect(response.body.data.needsAttention).toEqual({ awaitingPayment: 0, toProcess: 0, toShip: 0, codToCollect: 0 })
    expect(response.body.data.recentOrders[0]).toMatchObject({ orderNumber: order.orderNumber, itemCount: 2, total: 2000, status: 'DELIVERED' })
    expect(response.body.data.lowStockItems.map((item: { stock: number }) => item.stock)).toEqual([0, 3])

    const ranged = await api().get(`/api/v1/admin/dashboard?from=${new Date(Date.now() - 7 * 86_400_000).toISOString()}`).set(admin.auth)
    expect(ranged.body.data.seriesUnit).toBe('day')
    expect(ranged.body.data.revenueSeries.length).toBeGreaterThanOrEqual(7)
    expect(ranged.body.data.revenueSeries.reduce((sum: number, point: { value: number }) => sum + point.value, 0)).toBe(2000)
    expect(ranged.body.data.previous).toMatchObject({ totalSales: 0, totalOrders: 0 })
    expect((await api().get('/api/v1/admin/dashboard?from=2030-01-01&to=2020-01-01').set(admin.auth)).status).toBe(400)
  })
})

describe('admin customers', () => {
  it('lists customers without secrets and can block one, revoking their session', async () => {
    const admin = await loginAs('ADMIN')
    const customer = await loginAs()
    const list = await api().get('/api/v1/admin/customers').set(admin.auth)
    expect(list.body.data.items).toHaveLength(1)
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|tokenVersion|passwordReset/)
    expect((await api().patch(`/api/v1/admin/customers/${customer.user.id}/status`).set(admin.auth).send({ status: 'BLOCKED' })).status).toBe(200)
    expect((await api().get('/api/v1/auth/me').set(customer.auth)).status).toBe(401)
    // Admin accounts cannot be modified through this endpoint, and roles are not editable at all.
    expect((await api().patch(`/api/v1/admin/customers/${admin.user.id}/status`).set(admin.auth).send({ status: 'BLOCKED' })).status).toBe(404)
    expect((await api().patch(`/api/v1/admin/customers/${customer.user.id}/status`).set(admin.auth).send({ status: 'ACTIVE', role: 'ADMIN' })).status).toBe(200)
    expect((await User.findById(customer.user.id).lean())!.role).toBe('CUSTOMER')
  })

  it('denies customers access to other customers\' data', async () => {
    const customer = await loginAs()
    const other = await loginAs()
    expect((await api().get('/api/v1/admin/customers').set(customer.auth)).status).toBe(403)
    expect((await api().get(`/api/v1/admin/customers/${other.user.id}`).set(customer.auth)).status).toBe(403)
    expect((await api().get('/api/v1/admin/orders').set(customer.auth)).status).toBe(403)
    expect((await api().get('/api/v1/admin/dashboard').set(customer.auth)).status).toBe(403)
  })
})

describe('admin coupons, categories and settings', () => {
  it('manages coupons with validation', async () => {
    const { auth } = await loginAs('ADMIN')
    expect((await api().post('/api/v1/admin/coupons').set(auth).send({ code: 'TOO-MUCH', discountType: 'PERCENT', amount: 150 })).status).toBe(400)
    const created = await api().post('/api/v1/admin/coupons').set(auth).send({ code: 'winter10', discountType: 'PERCENT', amount: 10 })
    expect(created.status).toBe(201)
    expect(created.body.data.code).toBe('WINTER10')
    expect((await api().post('/api/v1/admin/coupons').set(auth).send({ code: 'WINTER10', discountType: 'FIXED', amount: 5 })).status).toBe(409)
    expect((await api().patch(`/api/v1/admin/coupons/${created.body.data._id}`).set(auth).send({ active: false })).body.data.active).toBe(false)
    expect((await api().delete(`/api/v1/admin/coupons/${created.body.data._id}`).set(auth)).body.data.deleted).toBe(true)
  })

  it('manages categories and protects categories in use', async () => {
    const { auth } = await loginAs('ADMIN')
    const created = await api().post('/api/v1/admin/categories').set(auth).send({ name: 'Luxury Candles', slug: 'luxury-candles' })
    expect(created.status).toBe(201)
    await createProduct({ category: 'Luxury Candles' })
    const publicList = await api().get('/api/v1/products/categories')
    expect(publicList.body.data[0]).toMatchObject({ slug: 'luxury-candles', count: 1 })
    expect((await api().delete(`/api/v1/admin/categories/${created.body.data._id}`).set(auth)).status).toBe(409)
  })

  it('updates store and announcement settings with validation', async () => {
    const { auth } = await loginAs('ADMIN')
    const store = await api().put('/api/v1/admin/settings/store').set(auth).send({ codMaxOrderValue: 5000, shippingFee: 60 })
    expect(store.body.data).toMatchObject({ codMaxOrderValue: 5000, shippingFee: 60, codEnabled: true })
    expect((await api().put('/api/v1/admin/settings/store').set(auth).send({ codMaxOrderValue: null })).body.data.codMaxOrderValue).toBeUndefined()
    expect((await api().put('/api/v1/admin/settings/store').set(auth).send({ shippingFee: -1 })).status).toBe(400)
    expect((await api().put('/api/v1/admin/settings/announcement').set(auth).send({ enabled: true, message: 'Diwali sale', ctaUrl: 'javascript:alert(1)' })).status).toBe(400)
    await api().put('/api/v1/admin/settings/announcement').set(auth).send({ enabled: true, message: 'Diwali sale' })
    expect((await api().get('/api/v1/cms/announcement')).body.data).toMatchObject({ enabled: true, message: 'Diwali sale' })
  })

  it('requires media storage configuration before issuing upload signatures', async () => {
    const { auth } = await loginAs('ADMIN')
    expect((await api().post('/api/v1/admin/media/signature').set(auth).send({ folder: 'hero', resourceType: 'video' })).status).toBe(503)
  })
})

describe('platform', () => {
  it('exposes health checks without infrastructure details', async () => {
    const ready = await api().get('/ready')
    expect(ready.status).toBe(200)
    expect(JSON.stringify(ready.body)).not.toMatch(/mongodb:|127\.0\.0\.1/)
    expect((await api().get('/health')).status).toBe(200)
  })

  it('applies CORS rules and security headers', async () => {
    const allowed = await api().get('/health').set('Origin', 'http://localhost:5173')
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    const blocked = await api().get('/health').set('Origin', 'https://evil.example')
    expect(blocked.status).toBe(403)
    expect(allowed.headers['x-powered-by']).toBeUndefined()
    expect(allowed.headers['x-content-type-options']).toBe('nosniff')
  })

  it('returns JSON errors for unknown routes, bad JSON and oversized bodies', async () => {
    expect((await api().get('/api/v1/nope')).body.error.code).toBe('ROUTE_NOT_FOUND')
    expect((await api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{bad')).body.error.code).toBe('INVALID_JSON')
    expect((await api().post('/api/v1/auth/login').send({ email: 'a@b.co', password: 'x'.repeat(2_000_000) })).status).toBe(413)
  })
})
