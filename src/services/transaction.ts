import mongoose, { type ClientSession } from 'mongoose'
import { logger } from '../config/logger.js'

let supported: boolean | undefined

/** Transactions require a replica set or sharded cluster (Atlas always qualifies; a standalone mongod does not). */
export const transactionsSupported = async () => {
  if (supported !== undefined) return supported
  const db = mongoose.connection.db
  if (!db) return false
  try {
    const hello = await db.admin().command({ hello: 1 })
    supported = Boolean(hello.setName) || hello.msg === 'isdbgrid'
  } catch {
    supported = false
  }
  if (!supported) logger.warn('MongoDB transactions unavailable (standalone server); multi-document writes use compensation instead')
  return supported
}

/** Test hook to force a topology decision. */
export const setTransactionsSupported = (value: boolean | undefined) => { supported = value }

/**
 * Runs `work` inside a transaction when supported. Without transaction support `work`
 * receives no session and must undo its own partial writes on failure (see `Compensator`).
 */
export const runAtomic = async <T>(work: (session: ClientSession | undefined) => Promise<T>): Promise<T> => {
  if (!(await transactionsSupported())) return work(undefined)
  const session = await mongoose.startSession()
  try {
    let result: T | undefined
    await session.withTransaction(async () => { result = await work(session) })
    return result as T
  } finally {
    await session.endSession()
  }
}

/** Records undo steps for writes made outside a transaction. With a session, rollback is left to MongoDB. */
export class Compensator {
  private undo: Array<() => Promise<unknown>> = []

  constructor(private session: ClientSession | undefined) {}

  add(step: () => Promise<unknown>) {
    if (!this.session) this.undo.push(step)
  }

  async rollback() {
    for (const step of this.undo.reverse()) {
      try {
        await step()
      } catch (error) {
        logger.error({ message: error instanceof Error ? error.message : String(error) }, 'Compensation step failed; manual inventory reconciliation may be required')
      }
    }
    this.undo = []
  }
}
