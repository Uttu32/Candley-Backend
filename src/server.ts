import { createServer } from 'node:http'
import { app } from './app.js'
import { connectDatabase, disconnectDatabase } from './config/database.js'
import { env } from './config/env.js'
import { logger } from './config/logger.js'

const server = createServer(app)

const start = async () => {
  await connectDatabase()
  server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'Candley Aroma API listening'))
}

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Graceful shutdown started')
  server.close(async () => {
    await disconnectDatabase()
    process.exit(0)
  })
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
start().catch((error) => { logger.error({ error }, 'Failed to start server'); process.exit(1) })
