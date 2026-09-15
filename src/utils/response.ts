import type { Response } from 'express'

export const sendSuccess = (response: Response, data: unknown, message = 'Operation successful', status = 200) =>
  response.status(status).json({ success: true, message, data })
