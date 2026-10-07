const defaultCodes: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE',
  429: 'TOO_MANY_REQUESTS',
  503: 'SERVICE_UNAVAILABLE',
}

export class ApiError extends Error {
  public code: string

  constructor(public statusCode: number, message: string, public details: unknown[] = [], code?: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code ?? defaultCodes[statusCode] ?? 'API_ERROR'
  }
}
