import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import helmet from 'helmet'
import { pinoHttp } from 'pino-http'
import swaggerUi from 'swagger-ui-express'
import { env, isProduction } from './config/env.js'
import { logger } from './config/logger.js'
import { healthRouter } from './routes/health.js'
import { authRouter } from './routes/auth.js'
import { accountRouter } from './routes/account.js'
import { adminRouter } from './routes/admin/index.js'
import { cmsRouter } from './routes/cms.js'
import { productsRouter } from './routes/products.js'
import { cartRouter } from './routes/cart.js'
import { wishlistRouter } from './routes/wishlist.js'
import { ordersRouter } from './routes/orders.js'
import { paymentsRouter } from './routes/payments.js'
import { globalLimiter } from './middlewares/rate-limit.js'
import { notFound, errorHandler } from './middlewares/error.js'

const allowedOrigins = new Set([env.CLIENT_URL, env.ADMIN_URL, ...(env.CORS_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? [])].map((origin) => origin.replace(/\/$/, '')))
// LAN origins are convenient for testing on devices during development only.
const devOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+):\d+$/

export const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(helmet())
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin) || (!isProduction && devOriginPattern.test(origin))) {
      callback(null, true)
      return
    }
    callback(new Error('Not allowed by CORS'))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  exposedHeaders: ['X-Total-Count', 'X-Total-Pages'],
}))
app.use(pinoHttp({ logger, autoLogging: { ignore: (request) => request.url === '/health' || request.url === '/live' } }))
app.use(globalLimiter)

// The webhook needs the raw body for signature verification, so it is mounted before the JSON parser.
app.use('/api/v1/payments', paymentsRouter)

app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false, limit: '100kb' }))
app.use(cookieParser())

app.use(healthRouter)
app.use('/api/v1/auth', authRouter)
app.use('/api/v1/account', accountRouter)
app.use('/api/v1/admin', adminRouter)
app.use('/api/v1/cms', cmsRouter)
app.use('/api/v1/products', productsRouter)
app.use('/api/v1/cart', cartRouter)
app.use('/api/v1/wishlist', wishlistRouter)
app.use('/api/v1/orders', ordersRouter)
if (!isProduction) {
  app.use('/docs', swaggerUi.serve, swaggerUi.setup({ openapi: '3.0.3', info: { title: 'Candley Aroma API', version: '0.2.0', description: 'See docs/api-reference.md for the endpoint reference.' }, servers: [{ url: '/api/v1' }], paths: {} }))
}
app.use(notFound)
app.use(errorHandler)
