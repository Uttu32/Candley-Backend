import type { TestProject } from 'vitest/node'
import { MongoMemoryReplSet } from 'mongodb-memory-server'

let replSet: MongoMemoryReplSet | undefined

/** One in-memory replica set for the whole run, so MongoDB transactions behave as in production. */
export default async function setup(project: TestProject) {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  project.provide('mongoUri', replSet.getUri())
  return async () => { await replSet?.stop() }
}

declare module 'vitest' {
  export interface ProvidedContext { mongoUri: string }
}
