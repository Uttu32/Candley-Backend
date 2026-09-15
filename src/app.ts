import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { pinoHttp } from 'pino-http'
import swaggerUi from 'swagger-ui-express'
import { env } from './config/env.js'
import { logger } from './config/logger.js'
import { healthRouter } from './routes/health.js'
import { authRouter } from './routes/auth.js'
import { adminRouter } from './routes/admin.js'
import { cmsRouter } from './routes/cms.js'
import { productsRouter } from './routes/products.js'
import { cartRouter } from './routes/cart.js'
import { wishlistRouter } from './routes/wishlist.js'
import { ordersRouter } from './routes/orders.js'
import { notFound, errorHandler } from './middlewares/error.js'

export const app = express()
app.set('trust proxy', 1)
app.use(helmet())
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [env.CLIENT_URL, env.ADMIN_URL].filter(Boolean)
    const isLocalOrigin = typeof origin === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+):\d+$/.test(origin)

    if (!origin || allowedOrigins.includes(origin) || isLocalOrigin) {
      callback(null, true)
      return
    }

    callback(new Error('Not allowed by CORS'))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
app.use(rateLimit({ windowMs: 60_000, max: 250, standardHeaders: true, legacyHeaders: false }))
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false, limit: '100kb' }))
app.use(cookieParser())
app.use(pinoHttp({ logger }))

app.use(healthRouter)
app.use('/api/v1/auth', authRouter)
app.use('/api/v1/admin', adminRouter)
app.use('/api/v1/cms', cmsRouter)
app.use('/api/v1/products', productsRouter)
app.use('/api/v1/cart', cartRouter)
app.use('/api/v1/wishlist', wishlistRouter)
app.use('/api/v1/orders', ordersRouter)
app.use('/docs', swaggerUi.serve, swaggerUi.setup({ openapi: '3.0.3', info: { title: 'Candley Aroma API', version: '0.1.0' }, servers: [{ url: '/api/v1' }] }))
app.use(notFound)
app.use(errorHandler)
