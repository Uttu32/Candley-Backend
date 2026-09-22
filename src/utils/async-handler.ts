import type { NextFunction, Request, RequestHandler, Response } from 'express'

export const asyncHandler = (handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler =>
  (request, response, next) => { void Promise.resolve().then(() => handler(request, response, next)).catch(next) }
