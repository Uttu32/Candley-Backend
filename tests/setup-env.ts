import { inject } from 'vitest'

// Must run before any application module reads configuration. Values are test-only placeholders.
const base = inject('mongoUri')
const dbName = `candley_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
const url = new URL(base)
url.pathname = `/${dbName}`

Object.assign(process.env, {
  NODE_ENV: 'test',
  CLIENT_URL: 'http://localhost:5173',
  ADMIN_URL: 'http://localhost:5173',
  MONGO_URI: url.toString(),
  JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-0001',
  JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret-0002',
  RAZORPAY_KEY_ID: 'rzp_test_dummykey',
  RAZORPAY_KEY_SECRET: 'test-razorpay-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'test-razorpay-webhook-secret',
  CLOUDINARY_CLOUD_NAME: '',
  CLOUDINARY_API_KEY: '',
  CLOUDINARY_API_SECRET: '',
  SMTP_HOST: '',
})
