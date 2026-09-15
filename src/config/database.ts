import mongoose from 'mongoose'
import { env } from './env.js'
import { logger } from './logger.js'

export const connectDatabase = async () => {
  await mongoose.connect(env.MONGO_URI, {
    maxPoolSize: 20,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
  logger.info('MongoDB connected')
}

export const disconnectDatabase = async () => {
  await mongoose.disconnect()
}
