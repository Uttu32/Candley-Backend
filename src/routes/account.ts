import { Router } from 'express'
import { z } from 'zod'
import { User } from '../models/User.js'
import { authenticate } from '../middlewares/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { ApiError } from '../utils/api-error.js'
import { sendSuccess } from '../utils/response.js'
import { objectIdSchema } from '../utils/validation.js'

export const addressInputSchema = z.object({
  label: z.string().trim().max(40).default('Home'),
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(8).max(20).regex(/^[\d+\-\s()]+$/, 'Invalid phone number'),
  addressLine1: z.string().trim().min(3).max(200),
  addressLine2: z.string().trim().max(200).default(''),
  city: z.string().trim().min(2).max(100),
  state: z.string().trim().min(2).max(100),
  postalCode: z.string().trim().min(4).max(12).regex(/^[A-Za-z\d\s-]+$/, 'Invalid postal code'),
  country: z.string().trim().min(2).max(60).default('India'),
  isDefault: z.boolean().default(false),
})

const maxAddresses = 10

export const accountRouter = Router()
accountRouter.use(authenticate)

const loadAddresses = async (userId: string) => {
  const user = await User.findById(userId).select('addresses')
  if (!user) throw new ApiError(404, 'Account not found')
  return user
}

accountRouter.get('/addresses', asyncHandler(async (request, response) => {
  sendSuccess(response, (await loadAddresses(request.auth!.sub)).addresses)
}))

accountRouter.post('/addresses', asyncHandler(async (request, response) => {
  const input = addressInputSchema.parse(request.body)
  const user = await loadAddresses(request.auth!.sub)
  if (user.addresses.length >= maxAddresses) throw new ApiError(422, `You can save up to ${maxAddresses} addresses`)
  const isDefault = input.isDefault || user.addresses.length === 0
  if (isDefault) user.addresses.forEach((address) => { address.isDefault = false })
  user.addresses.push({ ...input, isDefault })
  await user.save()
  sendSuccess(response, user.addresses, 'Address saved', 201)
}))

accountRouter.patch('/addresses/:addressId', asyncHandler(async (request, response) => {
  const addressId = objectIdSchema.parse(request.params.addressId)
  const input = addressInputSchema.partial().parse(request.body)
  const user = await loadAddresses(request.auth!.sub)
  const address = user.addresses.id(addressId)
  if (!address) throw new ApiError(404, 'Address not found')
  if (input.isDefault) user.addresses.forEach((entry) => { entry.isDefault = false })
  // A default address can only stop being default by making another address the default.
  if (input.isDefault === false && address.isDefault) delete input.isDefault
  address.set(input)
  await user.save()
  sendSuccess(response, user.addresses, 'Address updated')
}))

accountRouter.delete('/addresses/:addressId', asyncHandler(async (request, response) => {
  const addressId = objectIdSchema.parse(request.params.addressId)
  const user = await loadAddresses(request.auth!.sub)
  const address = user.addresses.id(addressId)
  if (!address) throw new ApiError(404, 'Address not found')
  const wasDefault = address.isDefault
  address.deleteOne()
  if (wasDefault && user.addresses[0]) user.addresses[0].isDefault = true
  await user.save()
  sendSuccess(response, user.addresses, 'Address removed')
}))
