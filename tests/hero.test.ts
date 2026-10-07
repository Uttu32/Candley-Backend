import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HeroSlide } from '../src/models/HeroSlide.js'
import { api, connectTestDb, disconnectTestDb, loginAs, resetDb } from './helpers.js'

beforeAll(connectTestDb)
afterAll(disconnectTestDb)
beforeEach(resetDb)

const day = 24 * 60 * 60 * 1000
const slide = (overrides: Record<string, unknown> = {}) => ({
  heading: 'Autumn Collection',
  subheading: 'Warm notes for cooler evenings',
  ctaText: 'Shop now',
  ctaUrl: '/shop',
  desktopImage: 'https://res.cloudinary.com/demo/image/upload/hero.jpg',
  ...overrides,
})

describe('public hero endpoint', () => {
  it('returns only active, scheduled-now slides with media, in display order', async () => {
    const now = Date.now()
    await HeroSlide.create([
      { ...slide({ heading: 'Second' }), sortOrder: 2 },
      { ...slide({ heading: 'First' }), sortOrder: 1 },
      { ...slide({ heading: 'Inactive' }), active: false, sortOrder: 0 },
      { ...slide({ heading: 'Future' }), startsAt: new Date(now + day), sortOrder: 0 },
      { ...slide({ heading: 'Expired' }), endsAt: new Date(now - day), sortOrder: 0 },
      { ...slide({ heading: 'No media', desktopImage: '' }), sortOrder: 0 },
      { ...slide({ heading: 'Video only', desktopImage: '', desktopVideo: 'https://res.cloudinary.com/demo/video/upload/v.mp4' }), sortOrder: 3 },
    ])
    const response = await api().get('/api/v1/cms/hero')
    expect(response.status).toBe(200)
    expect(response.body.data.map((entry: { heading: string }) => entry.heading)).toEqual(['First', 'Second', 'Video only'])
  })
})

describe('admin hero management', () => {
  it('creates, updates, reorders, deactivates and deletes slides with changes persisted and visible publicly', async () => {
    const { auth } = await loginAs('ADMIN')
    const a = await api().post('/api/v1/admin/cms/hero').set(auth).send(slide({ heading: 'Slide A' }))
    const b = await api().post('/api/v1/admin/cms/hero').set(auth).send(slide({ heading: 'Slide B' }))
    expect(a.status).toBe(201)
    expect(b.body.data.sortOrder).toBeGreaterThan(a.body.data.sortOrder)
    expect(a.body.data.imageAlt).toBe('Slide A')

    const updated = await api().patch(`/api/v1/admin/cms/hero/${a.body.data._id}`).set(auth).send({ heading: 'Slide A2', secondaryCta: { text: 'Gifts', url: '/gift-sets' }, overlay: { color: '#112233', opacity: 0.5 } })
    expect(updated.status).toBe(200)
    expect((await HeroSlide.findById(a.body.data._id).lean())!.heading).toBe('Slide A2')

    const reordered = await api().put('/api/v1/admin/cms/hero/order').set(auth).send({ ids: [b.body.data._id, a.body.data._id] })
    expect(reordered.status).toBe(200)
    expect((await api().get('/api/v1/cms/hero')).body.data.map((entry: { heading: string }) => entry.heading)).toEqual(['Slide B', 'Slide A2'])

    await api().post(`/api/v1/admin/cms/hero/${b.body.data._id}/deactivate`).set(auth)
    expect((await api().get('/api/v1/cms/hero')).body.data).toHaveLength(1)
    await api().post(`/api/v1/admin/cms/hero/${b.body.data._id}/activate`).set(auth)
    expect((await api().get('/api/v1/cms/hero')).body.data).toHaveLength(2)

    expect((await api().delete(`/api/v1/admin/cms/hero/${a.body.data._id}`).set(auth)).status).toBe(200)
    expect(await HeroSlide.countDocuments()).toBe(1)
  })

  it('accepts slides created before media is uploaded (admin UI flow)', async () => {
    const { auth } = await loginAs('ADMIN')
    const response = await api().post('/api/v1/admin/cms/hero').set(auth).send({ heading: 'Draft slide', subheading: 'Image to follow', active: true, sortOrder: 1 })
    expect(response.status).toBe(201)
    expect((await api().get('/api/v1/cms/hero')).body.data).toHaveLength(0)
  })

  it('rejects unsafe CTA links and media URLs', async () => {
    const { auth } = await loginAs('ADMIN')
    for (const ctaUrl of ['javascript:alert(1)', '//evil.example', 'http://insecure.example', 'data:text/html,hi']) {
      expect((await api().post('/api/v1/admin/cms/hero').set(auth).send(slide({ ctaUrl }))).status).toBe(400)
    }
    expect((await api().post('/api/v1/admin/cms/hero').set(auth).send(slide({ desktopImage: 'javascript:alert(1)' }))).status).toBe(400)
    expect((await api().post('/api/v1/admin/cms/hero').set(auth).send(slide({ ctaUrl: 'https://candleyaroma.example/sale' }))).status).toBe(201)
  })

  it('rejects inconsistent media configuration, bad schedules and unknown fields', async () => {
    const { auth } = await loginAs('ADMIN')
    const mobileVideoOnly = await api().post('/api/v1/admin/cms/hero').set(auth).send(slide({ desktopImage: '', mobileVideo: 'https://res.cloudinary.com/demo/video/upload/m.mp4' }))
    expect(mobileVideoOnly.status).toBe(400)
    expect(mobileVideoOnly.body.error.code).toBe('INVALID_SLIDE')
    const schedule = await api().post('/api/v1/admin/cms/hero').set(auth).send(slide({ startsAt: '2026-12-10', endsAt: '2026-12-01' }))
    expect(schedule.status).toBe(400)
    expect((await api().post('/api/v1/admin/cms/hero').set(auth).send(slide({ overlayPosition: 'somewhere' }))).status).toBe(400)
    expect((await api().post('/api/v1/admin/cms/hero').set(auth).send(slide({ $where: '1' }))).status).toBe(400)
  })

  it('accepts explicit null schedule dates (clearing a schedule)', async () => {
    const { auth } = await loginAs('ADMIN')
    const created = await api().post('/api/v1/admin/cms/hero').set(auth).send(slide({ startsAt: null, endsAt: null }))
    expect(created.status).toBe(201)
    expect(created.body.data.startsAt ?? null).toBeNull()
    const scheduled = await api().patch(`/api/v1/admin/cms/hero/${created.body.data._id}`).set(auth).send({ startsAt: '2030-01-01T00:00:00.000Z' })
    expect(scheduled.status).toBe(200)
    const cleared = await api().patch(`/api/v1/admin/cms/hero/${created.body.data._id}`).set(auth).send({ startsAt: null })
    expect(cleared.status).toBe(200)
    expect((await api().get('/api/v1/cms/hero')).body.data).toHaveLength(1)
  })

  it('requires the reorder list to contain every slide exactly once', async () => {
    const { auth } = await loginAs('ADMIN')
    const a = await api().post('/api/v1/admin/cms/hero').set(auth).send(slide())
    await api().post('/api/v1/admin/cms/hero').set(auth).send(slide())
    expect((await api().put('/api/v1/admin/cms/hero/order').set(auth).send({ ids: [a.body.data._id] })).status).toBe(409)
    expect((await api().put('/api/v1/admin/cms/hero/order').set(auth).send({ ids: [a.body.data._id, a.body.data._id] })).status).toBe(400)
  })

  it('refuses to upload when media storage is not configured, without changing the slide', async () => {
    const { auth } = await loginAs('ADMIN')
    const created = await api().post('/api/v1/admin/cms/hero').set(auth).send(slide())
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
    const response = await api().post(`/api/v1/admin/cms/hero/${created.body.data._id}/image`).set(auth).field('target', 'mobileImage').attach('image', png, { filename: 'm.png', contentType: 'image/png' })
    expect(response.status).toBe(503)
    expect((await HeroSlide.findById(created.body.data._id).lean())!.mobileImage).toBe('')
  })

  it('blocks customers from every hero write', async () => {
    const admin = await loginAs('ADMIN')
    const created = await api().post('/api/v1/admin/cms/hero').set(admin.auth).send(slide())
    const { auth } = await loginAs('CUSTOMER')
    const id = created.body.data._id
    const attempts = await Promise.all([
      api().get('/api/v1/admin/cms/hero').set(auth),
      api().post('/api/v1/admin/cms/hero').set(auth).send(slide()),
      api().patch(`/api/v1/admin/cms/hero/${id}`).set(auth).send({ heading: 'Hacked' }),
      api().put('/api/v1/admin/cms/hero/order').set(auth).send({ ids: [id] }),
      api().post(`/api/v1/admin/cms/hero/${id}/deactivate`).set(auth),
      api().delete(`/api/v1/admin/cms/hero/${id}`).set(auth),
    ])
    for (const response of attempts) expect(response.status).toBe(403)
    expect((await HeroSlide.findById(id).lean())!).toMatchObject({ heading: 'Autumn Collection', active: true })
  })
})
