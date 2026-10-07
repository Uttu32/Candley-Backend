/**
 * Provisions an administrator account. There is no public admin sign-up; this is the only way to create one.
 *
 *   npm run admin:create -- --email owner@example.com --name "Store Owner" [--role SUPER_ADMIN] [--promote] [--reset-password]
 *
 * The password is read from the ADMIN_BOOTSTRAP_PASSWORD environment variable or, if unset, prompted for
 * on the terminal without echo. It is never printed or logged.
 *
 * Safety rules:
 * - An existing admin is left unchanged unless --reset-password is passed.
 * - An existing customer account is only promoted with --promote (prevents accidental escalation).
 * - Promoting or resetting revokes the account's existing sessions.
 */
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline'
import argon2 from 'argon2'
import { z } from 'zod'
import { connectDatabase, disconnectDatabase } from '../config/database.js'
import { User, adminRoles } from '../models/User.js'
import { RefreshToken } from '../models/RefreshToken.js'

const readHiddenInput = (prompt: string) => new Promise<string>((resolve, reject) => {
  if (!process.stdin.isTTY) {
    reject(new Error('No terminal available; set ADMIN_BOOTSTRAP_PASSWORD instead'))
    return
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const write = (rl as unknown as { _writeToOutput: (text: string) => void })
  write._writeToOutput = (text: string) => { if (text.includes(prompt)) process.stdout.write(prompt) }
  rl.question(prompt, (answer) => {
    rl.close()
    process.stdout.write('\n')
    resolve(answer)
  })
})

const main = async () => {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string', default: 'Store administrator' },
      role: { type: 'string', default: 'ADMIN' },
      promote: { type: 'boolean', default: false },
      'reset-password': { type: 'boolean', default: false },
    },
  })
  const email = z.string().trim().toLowerCase().email().parse(values.email ?? process.env.ADMIN_EMAIL)
  const role = z.enum(adminRoles).parse(values.role)
  const name = z.string().trim().min(2).max(100).parse(values.name)

  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? (await readHiddenInput('Admin password (min 12 chars): '))
  z.string().min(12, 'Admin password must be at least 12 characters').max(128).parse(password)

  await connectDatabase()
  try {
    const existing = await User.findOne({ email })
    if (!existing) {
      await User.create({ name, email, passwordHash: await argon2.hash(password), role, status: 'ACTIVE', emailVerified: true })
      console.log(`Created ${role} account for ${email}`)
      return
    }
    const isAdmin = (adminRoles as readonly string[]).includes(existing.role)
    if (!isAdmin && !values.promote) {
      throw new Error(`${email} is an existing ${existing.role} account. Re-run with --promote to grant ${role}.`)
    }
    if (isAdmin && !values['reset-password'] && existing.role === role) {
      console.log(`${email} is already ${existing.role}; nothing changed (use --reset-password to set a new password)`)
      return
    }
    existing.role = role
    existing.status = 'ACTIVE'
    if (values['reset-password'] || !isAdmin) existing.passwordHash = await argon2.hash(password)
    existing.tokenVersion = (existing.tokenVersion ?? 0) + 1
    await existing.save()
    await RefreshToken.deleteMany({ userId: existing._id })
    console.log(`Updated ${email}: role ${role}${values['reset-password'] || !isAdmin ? ', password reset' : ''}; existing sessions revoked`)
  } finally {
    await disconnectDatabase()
  }
}

main().catch((error) => {
  console.error(`Admin provisioning failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
