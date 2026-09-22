import mongoose from 'mongoose'
import { env } from './env.js'
import { logger } from './logger.js'

export const connectDatabase = async () => {
  try {
    await mongoose.connect(env.MONGO_URI, {
      maxPoolSize: 20,
      minPoolSize: 2,
      family: 4,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error({ message }, 'MongoDB connection failed; verify Atlas cluster state, network access, and credentials')
    throw error
  }
  logger.info('MongoDB connected')
}

export const disconnectDatabase = async () => {
  await mongoose.disconnect()
}
