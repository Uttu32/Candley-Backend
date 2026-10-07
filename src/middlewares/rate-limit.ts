import rateLimit from 'express-rate-limit'
import { env } from '../config/env.js'

const message = (text: string) => ({ success: false, message: text, error: { code: 'TOO_MANY_REQUESTS', message: text } })
const skip = () => env.NODE_ENV === 'test'

export const globalLimiter = rateLimit({ windowMs: 60_000, limit: 250, standardHeaders: 'draft-7', legacyHeaders: false, skip, message: message('Too many requests, please slow down') })

/** Login, registration and password-reset attempts per IP. */
export const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, skip, message: message('Too many attempts, please try again later') })

export const checkoutLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, skip, message: message('Too many checkout attempts, please wait a moment') })
