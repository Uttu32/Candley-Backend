import 'dotenv/config'
import { z } from 'zod'

const optionalString = z.preprocess((value) => (value === '' ? undefined : value), z.string().optional())

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  CLIENT_URL: z.string().url(),
  ADMIN_URL: z.string().url(),
  /** Comma-separated extra origins allowed by CORS (e.g. a staging storefront). */
  CORS_ORIGINS: optionalString,
  MONGO_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  COOKIE_DOMAIN: optionalString,
  /** `none` lets the storefront and API live on different sites (e.g. vercel.app + another host); requires HTTPS. */
  COOKIE_SAMESITE: z.preprocess((value) => (value === '' ? undefined : value), z.enum(['lax', 'strict', 'none']).optional()),
  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,
  /** Minutes an unpaid Razorpay order holds reserved stock before it is cancelled. */
  PAYMENT_RESERVATION_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(30),
  LOG_LEVEL: z.string().default('info'),
  CLOUDINARY_CLOUD_NAME: optionalString,
  CLOUDINARY_API_KEY: optionalString,
  CLOUDINARY_API_SECRET: optionalString,
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  MAIL_FROM: optionalString,
}).superRefine((value, context) => {
  const razorpay = [value.RAZORPAY_KEY_ID, value.RAZORPAY_KEY_SECRET]
  if (razorpay.some(Boolean) && !razorpay.every(Boolean)) {
    context.addIssue({ code: 'custom', path: ['RAZORPAY_KEY_SECRET'], message: 'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set together' })
  }
  const cloudinary = [value.CLOUDINARY_CLOUD_NAME, value.CLOUDINARY_API_KEY, value.CLOUDINARY_API_SECRET]
  if (cloudinary.some(Boolean) && !cloudinary.every(Boolean)) {
    context.addIssue({ code: 'custom', path: ['CLOUDINARY_API_SECRET'], message: 'All Cloudinary variables must be set together' })
  }
  if (value.SMTP_HOST && !value.MAIL_FROM) {
    context.addIssue({ code: 'custom', path: ['MAIL_FROM'], message: 'MAIL_FROM is required when SMTP_HOST is set' })
  }
  if (value.NODE_ENV === 'production') {
    if (value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET) {
      context.addIssue({ code: 'custom', path: ['JWT_REFRESH_SECRET'], message: 'Access and refresh secrets must differ in production' })
    }
    if (value.RAZORPAY_KEY_ID && !value.RAZORPAY_WEBHOOK_SECRET) {
      context.addIssue({ code: 'custom', path: ['RAZORPAY_WEBHOOK_SECRET'], message: 'RAZORPAY_WEBHOOK_SECRET is required in production when Razorpay is enabled' })
    }
  }
})

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  // Only variable names and messages are printed, never values.
  const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n')
  throw new Error(`Invalid environment configuration:\n${problems}`)
}

export const env = parsed.data
export const isProduction = env.NODE_ENV === 'production'
export const isRazorpayConfigured = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)
