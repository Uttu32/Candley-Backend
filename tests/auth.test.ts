import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { User } from '../src/models/User.js'
import { RefreshToken } from '../src/models/RefreshToken.js'
import { mailOutbox } from '../src/services/mailer.js'
import { api, connectTestDb, createUser, disconnectTestDb, loginAs, password, resetDb } from './helpers.js'

beforeAll(connectTestDb)
afterAll(disconnectTestDb)
beforeEach(resetDb)

const refreshCookieFrom = (cookies: string[]) => cookies.find((cookie) => cookie.startsWith('candley_refresh_token='))!.split(';')[0]!

describe('registration', () => {
  it('creates a customer with a hashed password and never returns secrets', async () => {
    const response = await api().post('/api/v1/auth/register').send({ name: 'Asha', email: 'Asha@Example.test', password })
    expect(response.status).toBe(201)
    expect(response.body.data).toMatchObject({ email: 'asha@example.test', role: 'CUSTOMER' })
    expect(JSON.stringify(response.body)).not.toContain('passwordHash')
    const stored = await User.findOne({ email: 'asha@example.test' }).select('+passwordHash').lean()
    expect(stored!.passwordHash).toMatch(/^\$argon2/)
    expect(stored!.passwordHash).not.toContain(password)
  })

  it('ignores a client-supplied role', async () => {
    const response = await api().post('/api/v1/auth/register').send({ name: 'Mallory', email: 'mallory@example.test', password, role: 'ADMIN' })
    expect(response.status).toBe(201)
    expect((await User.findOne({ email: 'mallory@example.test' }).lean())!.role).toBe('CUSTOMER')
  })

  it('rejects duplicate emails case-insensitively', async () => {
    await createUser({ email: 'dup@example.test' })
    const response = await api().post('/api/v1/auth/register').send({ name: 'Dup', email: 'DUP@example.test', password })
    expect(response.status).toBe(409)
    expect(response.body.message).toMatch(/already exists/)
  })

  it('validates input and reports a readable top-level message', async () => {
    const response = await api().post('/api/v1/auth/register').send({ name: 'A', email: 'not-an-email', password: 'short' })
    expect(response.status).toBe(400)
    expect(response.body.success).toBe(false)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    expect(typeof response.body.message).toBe('string')
  })
})

describe('login', () => {
  it('signs in a customer and sets an httpOnly refresh cookie', async () => {
    const user = await createUser()
    const response = await api().post('/api/v1/auth/login').send({ email: user.email, password })
    expect(response.status).toBe(200)
    expect(response.body.data.user).toMatchObject({ email: user.email, role: 'CUSTOMER', _id: user.id })
    const cookie = (response.headers['set-cookie'] as unknown as string[]).find((value) => value.startsWith('candley_refresh_token='))
    expect(cookie).toMatch(/HttpOnly/i)
  })

  it('signs in an admin through the same endpoint with the role from the database', async () => {
    const admin = await createUser({ role: 'ADMIN' })
    const response = await api().post('/api/v1/auth/login').send({ email: admin.email, password })
    expect(response.status).toBe(200)
    expect(response.body.data.user.role).toBe('ADMIN')
  })

  it('returns the same generic error for unknown email, wrong password and blocked accounts', async () => {
    const user = await createUser()
    const blocked = await createUser({ status: 'BLOCKED' })
    const responses = await Promise.all([
      api().post('/api/v1/auth/login').send({ email: 'nobody@example.test', password }),
      api().post('/api/v1/auth/login').send({ email: user.email, password: 'WrongPassword!1' }),
      api().post('/api/v1/auth/login').send({ email: blocked.email, password }),
    ])
    for (const response of responses) {
      expect(response.status).toBe(401)
      expect(response.body.message).toBe('Invalid email or password')
    }
  })

  it('admin-only login rejects customers with a generic error', async () => {
    const user = await createUser()
    const response = await api().post('/api/v1/admin/login').send({ email: user.email, password })
    expect(response.status).toBe(401)
    expect(response.body.message).toBe('Invalid admin credentials')
  })
})

describe('sessions', () => {
  it('rejects requests without a token, with a garbage token, or with an expired token', async () => {
    const { user } = await loginAs()
    const expired = jwt.sign({ sub: user.id, role: 'CUSTOMER', ver: 0, type: 'access' }, process.env.JWT_ACCESS_SECRET!, { expiresIn: -10 })
    expect((await api().get('/api/v1/auth/me')).status).toBe(401)
    expect((await api().get('/api/v1/auth/me').set('Authorization', 'Bearer garbage')).status).toBe(401)
    expect((await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${expired}`)).status).toBe(401)
  })

  it('rejects a refresh token used as an access token', async () => {
    const { cookie } = await loginAs()
    const refreshJwt = refreshCookieFrom(cookie).split('=')[1]!
    expect((await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${refreshJwt}`)).status).toBe(401)
  })

  it('rotates refresh tokens and revokes all sessions when an old token is replayed', async () => {
    const { cookie, user } = await loginAs()
    const first = refreshCookieFrom(cookie)
    const rotated = await api().post('/api/v1/auth/refresh').set('Cookie', first)
    expect(rotated.status).toBe(200)
    expect(rotated.body.data.accessToken).toBeTruthy()
    const replay = await api().post('/api/v1/auth/refresh').set('Cookie', first)
    expect(replay.status).toBe(401)
    expect(await RefreshToken.countDocuments({ userId: user.id })).toBe(0)
  })

  it('logout revokes the refresh token', async () => {
    const { cookie } = await loginAs()
    const refresh = refreshCookieFrom(cookie)
    expect((await api().post('/api/v1/auth/logout').set('Cookie', refresh)).status).toBe(200)
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', refresh)).status).toBe(401)
  })

  it('blocking an account invalidates its existing access token immediately', async () => {
    const { user, auth } = await loginAs()
    await User.updateOne({ _id: user.id }, { status: 'BLOCKED' })
    expect((await api().get('/api/v1/auth/me').set(auth)).status).toBe(401)
  })

  it('a role change in the database takes effect without re-login', async () => {
    const { user, auth } = await loginAs('ADMIN')
    expect((await api().get('/api/v1/admin/me').set(auth)).status).toBe(200)
    await User.updateOne({ _id: user.id }, { role: 'CUSTOMER' })
    expect((await api().get('/api/v1/admin/me').set(auth)).status).toBe(403)
  })
})

describe('profile and role escalation', () => {
  it('cannot change role or status through the profile endpoint', async () => {
    const { user, auth } = await loginAs()
    const response = await api().patch('/api/v1/auth/me').set(auth).send({ name: 'New Name', email: user.email, phone: '9876543210', dateOfBirth: '1990-01-01', role: 'SUPER_ADMIN', status: 'ACTIVE', emailVerified: true })
    expect(response.status).toBe(200)
    expect(response.body.data.role).toBe('CUSTOMER')
    const stored = await User.findById(user.id).lean()
    expect(stored!.role).toBe('CUSTOMER')
    expect(stored!.name).toBe('New Name')
  })

  it('rejects taking another user\'s email', async () => {
    const other = await createUser()
    const { auth } = await loginAs()
    const response = await api().patch('/api/v1/auth/me').set(auth).send({ name: 'Name', email: other.email })
    expect(response.status).toBe(409)
  })
})

describe('password management', () => {
  it('change-password requires the current password and revokes other sessions', async () => {
    const { user, auth } = await loginAs()
    expect((await api().post('/api/v1/auth/change-password').set(auth).send({ currentPassword: 'wrong-password', newPassword: 'AnotherPass!77' })).status).toBe(400)
    const changed = await api().post('/api/v1/auth/change-password').set(auth).send({ currentPassword: password, newPassword: 'AnotherPass!77' })
    expect(changed.status).toBe(200)
    expect((await api().get('/api/v1/auth/me').set(auth)).status).toBe(401)
    expect((await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${changed.body.data.accessToken}`)).status).toBe(200)
    expect((await api().post('/api/v1/auth/login').send({ email: user.email, password: 'AnotherPass!77' })).status).toBe(200)
  })

  it('forgot/reset password works once and does not reveal whether the email exists', async () => {
    const user = await createUser()
    const unknown = await api().post('/api/v1/auth/forgot-password').send({ email: 'ghost@example.test' })
    const known = await api().post('/api/v1/auth/forgot-password').send({ email: user.email })
    expect(unknown.status).toBe(200)
    expect(known.body.message).toBe(unknown.body.message)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mailOutbox).toHaveLength(1)
    const token = /token=([a-f0-9]{64})/.exec(mailOutbox![0]!.text)![1]!
    const stored = await User.findById(user.id).select('+passwordResetTokenHash').lean()
    expect(stored!.passwordResetTokenHash).not.toBe(token)

    expect((await api().post('/api/v1/auth/reset-password').send({ token, password: 'BrandNewPass!9' })).status).toBe(200)
    expect((await api().post('/api/v1/auth/reset-password').send({ token, password: 'BrandNewPass!9' })).status).toBe(400)
    expect((await api().post('/api/v1/auth/login').send({ email: user.email, password: 'BrandNewPass!9' })).status).toBe(200)
  })
})
