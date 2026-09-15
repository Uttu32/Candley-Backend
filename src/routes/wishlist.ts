import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../middlewares/auth.js'
import { asyncHandler } from '../utils/async-handler.js'
import { sendSuccess } from '../utils/response.js'
import mongoose, { Schema, model } from 'mongoose'

const wishlistSchema = new Schema({ userId: { type: Schema.Types.ObjectId, ref: 'User', unique: true }, productIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }] }, { timestamps: true })
const Wishlist = mongoose.models.Wishlist ?? model('Wishlist', wishlistSchema)
export const wishlistRouter = Router()
wishlistRouter.use(authenticate)
wishlistRouter.get('/', asyncHandler(async (request, response) => sendSuccess(response, await Wishlist.findOne({ userId: request.auth!.sub }).populate('productIds').lean() ?? { productIds: [] })))
wishlistRouter.post('/', asyncHandler(async (request, response) => { const productId = z.object({ productId: z.string() }).parse(request.body).productId; sendSuccess(response, await Wishlist.findOneAndUpdate({ userId: request.auth!.sub }, { $setOnInsert: { userId: request.auth!.sub }, $addToSet: { productIds: productId } }, { upsert: true, new: true }).lean(), 'Added to wishlist') }))
wishlistRouter.delete('/:productId', asyncHandler(async (request, response) => sendSuccess(response, await Wishlist.findOneAndUpdate({ userId: request.auth!.sub }, { $pull: { productIds: request.params.productId } }, { new: true }).lean(), 'Removed from wishlist'))) 
