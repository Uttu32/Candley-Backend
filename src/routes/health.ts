import { Router } from 'express'
import mongoose from 'mongoose'

export const healthRouter = Router()

healthRouter.get('/health', (_request, response) => response.json({ success: true, data: { status: 'ok' } }))
healthRouter.get('/live', (_request, response) => response.json({ success: true, data: { status: 'alive' } }))
healthRouter.get('/ready', (_request, response) => {
  const mongoReady = mongoose.connection.readyState === 1
  response.status(mongoReady ? 200 : 503).json({ success: mongoReady, data: { mongo: mongoReady } })
})
