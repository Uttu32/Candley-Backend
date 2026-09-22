import { Router } from 'express'
import mongoose from 'mongoose'
import { asyncHandler } from '../utils/async-handler.js'

export const healthRouter = Router()

healthRouter.get('/health', asyncHandler((_request, response) => response.json({ success: true, message: 'Operation successful', data: { status: 'ok' } })))
healthRouter.get('/live', asyncHandler((_request, response) => response.json({ success: true, message: 'Operation successful', data: { status: 'alive' } })))
healthRouter.get('/ready', asyncHandler((_request, response) => {
  const mongoReady = mongoose.connection.readyState === 1
  response.status(mongoReady ? 200 : 503).json(mongoReady
    ? { success: true, message: 'Operation successful', data: { mongo: true } }
    : { success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Database is not ready' } })
}))
