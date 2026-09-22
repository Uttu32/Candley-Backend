export class ApiError extends Error {
  constructor(public statusCode: number, message: string, public details: unknown[] = [], public code = 'API_ERROR') {
    super(message)
    this.name = 'ApiError'
  }
}
