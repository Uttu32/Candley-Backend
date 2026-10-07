import { createServer } from 'node:http'
import { app } from './app.js'
import { connectDatabase, disconnectDatabase } from './config/database.js'
import { env } from './config/env.js'
import { logger } from './config/logger.js'
import { expireUnpaidOrders } from './services/order.service.js'

const server = createServer(app)
let sweeper: NodeJS.Timeout | undefined

/** Releases stock held by online orders whose payment window has passed. */
const startReservationSweeper = () => {
  let running = false
  sweeper = setInterval(() => {
    if (running) return
    running = true
    expireUnpaidOrders()
      .then((count) => { if (count) logger.info({ count }, 'Expired unpaid orders released') })
      .catch((error) => logger.error({ message: error instanceof Error ? error.message : String(error) }, 'Reservation sweep failed'))
      .finally(() => { running = false })
  }, 60_000)
  sweeper.unref()
}

const start = async () => {
  await connectDatabase()
  startReservationSweeper()
  server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'Candley Aroma API listening'))
}

const shutdown = (signal: string) => {
  logger.info({ signal }, 'Graceful shutdown started')
  if (sweeper) clearInterval(sweeper)
  server.close(async () => {
    await disconnectDatabase()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
start().catch((error) => {
  logger.error({ message: error instanceof Error ? error.message : String(error) }, 'Failed to start server')
  process.exit(1)
})
