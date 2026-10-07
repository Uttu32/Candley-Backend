import { Router } from 'express'
import { Types } from 'mongoose'
import { z } from 'zod'
import { Product, productStatuses } from '../../models/Product.js'
import { Order } from '../../models/Order.js'
import { assertFileContent, destroyMediaByUrl, imageUpload, mediaFolders, uploadImage } from '../../config/cloudinary.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { ApiError } from '../../utils/api-error.js'
import { sendSuccess } from '../../utils/response.js'
import { escapeRegex, objectIdSchema, paginate, paginationSchema, parseJsonField, slugSchema } from '../../utils/validation.js'

const variantInputSchema = z.object({
  _id: objectIdSchema.optional(),
  label: z.string().trim().min(1).max(60),
  // May be blank when updating an existing variant; the stored SKU is then kept.
  sku: z.string().trim().max(80).default(''),
  price: z.coerce.number().nonnegative().max(10_000_000),
  stock: z.coerce.number().int().nonnegative().max(1_000_000),
  active: z.boolean().default(true),
})

const productInputSchema = z.object({
  name: z.string().trim().min(2).max(160),
  slug: slugSchema,
  sku: z.string().trim().min(2).max(80),
  category: z.string().trim().min(1).max(100),
  collection: z.string().trim().min(1).max(100),
  fragrance: z.string().trim().min(1).max(100),
  description: z.string().trim().min(2).max(10_000),
  shortDescription: z.string().trim().min(2).max(240),
  price: z.coerce.number().nonnegative().max(10_000_000),
  mrp: z.coerce.number().nonnegative().max(10_000_000),
  stock: z.coerce.number().int().nonnegative().max(1_000_000),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  status: z.enum(productStatuses).default('ACTIVE'),
  featured: z.boolean().default(false),
  badge: z.enum(['Bestseller', 'New', 'Limited', 'Trending', 'Sale', 'Sold Out', 'Low Stock']).nullable().optional(),
  variants: z.array(variantInputSchema).max(30).default([]),
  fragranceNotes: z.object({
    top: z.array(z.string().trim().max(60)).max(10).default([]),
    heart: z.array(z.string().trim().max(60)).max(10).default([]),
    base: z.array(z.string().trim().max(60)).max(10).default([]),
  }).optional(),
  specifications: z.array(z.object({ label: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(200) })).max(30).optional(),
  seo: z.object({ title: z.string().trim().max(70).default(''), description: z.string().trim().max(160).default('') }).optional(),
})

type ProductInput = z.infer<typeof productInputSchema>

const listQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(productStatuses).optional(),
  category: z.string().trim().max(100).optional(),
  lowStock: z.coerce.number().int().nonnegative().max(1000).optional(),
})

const inventorySchema = z.union([
  z.object({ variantId: objectIdSchema, stock: z.number().int().nonnegative().max(1_000_000) }),
  z.object({ variantId: objectIdSchema, delta: z.number().int().min(-1_000_000).max(1_000_000) }),
  z.object({ stock: z.number().int().nonnegative().max(1_000_000) }),
  z.object({ delta: z.number().int().min(-1_000_000).max(1_000_000) }),
])

/** Accepts JSON bodies or multipart with a JSON `product` field (what the admin UI sends). */
const readProductBody = (body: Record<string, unknown>) => {
  const raw = (body.product !== undefined ? parseJsonField(body.product, 'product') : body) as Record<string, unknown>
  if (!raw || typeof raw !== 'object') throw new ApiError(400, 'Product data is required', [], 'VALIDATION_ERROR')
  return {
    ...raw,
    ...(raw.tags !== undefined ? { tags: parseJsonField(raw.tags, 'tags') } : {}),
    ...(raw.variants !== undefined ? { variants: parseJsonField(raw.variants, 'variants') } : {}),
  }
}

/** Validates SKUs across the product and its variants before hitting MongoDB's unique indexes. */
const assertUniqueSkus = async (input: Pick<ProductInput, 'sku'> & { variants: Array<{ sku: string }> }, excludeId?: string) => {
  const skus = [input.sku, ...input.variants.map((variant) => variant.sku)].map((sku) => sku.toUpperCase())
  const duplicate = skus.find((sku, index) => skus.indexOf(sku) !== index)
  // The product SKU may equal its single variant's SKU (existing data does this); other repeats are errors.
  if (duplicate && !(input.variants.length === 1 && duplicate === input.sku.toUpperCase())) {
    throw new ApiError(409, `SKU "${duplicate}" is used more than once in this product`, [], 'DUPLICATE_SKU')
  }
  const exact = [...new Set([input.sku, ...input.variants.map((variant) => variant.sku)])]
  const clash = await Product.findOne({
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    $or: [{ sku: { $in: exact } }, { 'variants.sku': { $in: exact } }],
  }).select('name').lean()
  if (clash) throw new ApiError(409, `A SKU in this product is already used by "${clash.name}"`, [], 'DUPLICATE_SKU')
}

/**
 * Keeps variant ids stable across edits (carts and orders reference them): incoming variants are matched to
 * existing ones by `_id`, then SKU, then label. A blank SKU keeps the stored one; new variants need a SKU.
 */
const mergeVariants = (incoming: ProductInput['variants'], existing: Array<{ _id: Types.ObjectId; label: string; sku: string }>) => {
  const unused = [...existing]
  const take = (predicate: (variant: (typeof existing)[number]) => boolean) => {
    const index = unused.findIndex(predicate)
    return index === -1 ? undefined : unused.splice(index, 1)[0]
  }
  return incoming.map((variant) => {
    const match = (variant._id && take((entry) => String(entry._id) === variant._id))
      || (variant.sku && take((entry) => entry.sku === variant.sku))
      || take((entry) => entry.label === variant.label)
    if (variant._id && !match) throw new ApiError(422, `Variant ${variant._id} does not belong to this product`, [], 'VARIANT_NOT_FOUND')
    const sku = variant.sku || match?.sku
    if (!sku) throw new ApiError(400, `variants: SKU is required for new variant "${variant.label}"`, [], 'VALIDATION_ERROR')
    return { _id: match?._id ?? new Types.ObjectId(), label: variant.label, sku, price: variant.price, stock: variant.stock, active: variant.active }
  })
}

const assertPricing = (price: number, mrp: number) => {
  if (mrp < price) throw new ApiError(400, 'mrp: MRP must be greater than or equal to price', [], 'VALIDATION_ERROR')
}

const uploadFiles = async (files: Express.Multer.File[]) => {
  files.forEach((file) => assertFileContent(file, 'image'))
  const uploaded = await Promise.all(files.map((file) => uploadImage(file.buffer, mediaFolders.products)))
  return uploaded.map((image) => image.secure_url)
}

export const adminProductsRouter = Router()

adminProductsRouter.get('/', asyncHandler(async (request, response) => {
  const { page, limit, search, status, category, lowStock } = listQuerySchema.parse(request.query)
  const filter: Record<string, unknown> = {}
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i')
    filter.$or = [{ name: pattern }, { sku: pattern }, { slug: pattern }, { 'variants.sku': pattern }]
  }
  if (status) filter.status = status
  if (category) filter.category = new RegExp(`^${escapeRegex(category)}$`, 'i')
  if (lowStock !== undefined) filter.stock = { $lte: lowStock }
  const [items, total] = await Promise.all([
    Product.find(filter).sort({ createdAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Product.countDocuments(filter),
  ])
  sendSuccess(response, { items, pagination: paginate(page, limit, total) })
}))

adminProductsRouter.get('/:id', asyncHandler(async (request, response) => {
  const product = await Product.findById(objectIdSchema.parse(request.params.id)).lean()
  if (!product) throw new ApiError(404, 'Product not found')
  sendSuccess(response, product)
}))

adminProductsRouter.post('/', imageUpload.array('images', 12), asyncHandler(async (request, response) => {
  const input = productInputSchema.parse(readProductBody(request.body as Record<string, unknown>))
  assertPricing(input.price, input.mrp)
  const variants = mergeVariants(input.variants, [])
  await assertUniqueSkus({ sku: input.sku, variants })
  if (await Product.exists({ slug: input.slug })) throw new ApiError(409, 'A product with this slug already exists', [], 'DUPLICATE_SLUG')
  const images = await uploadFiles((request.files as Express.Multer.File[] | undefined) ?? [])
  const thumbnailIndex = Math.max(Number(request.body.thumbnailIndex) || 0, 0)
  try {
    const product = await Product.create({ ...input, variants, images, thumbnailImage: images[thumbnailIndex] ?? images[0] ?? '' })
    sendSuccess(response, product, 'Product created', 201)
  } catch (error) {
    await Promise.all(images.map(destroyMediaByUrl))
    throw error
  }
}))

/**
 * Updates a product. Accepts the full product (admin UI) or a partial update. New images are appended;
 * `removeImages` (JSON array of URLs) deletes images; `thumbnailIndex` selects the thumbnail from the result.
 */
adminProductsRouter.patch('/:id', imageUpload.array('images', 12), asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const input = productInputSchema.partial().parse(readProductBody(request.body as Record<string, unknown>))
  const removeImages = z.array(z.string().max(500)).max(50).default([]).parse(parseJsonField(request.body.removeImages, 'removeImages'))
  const product = await Product.findById(id)
  if (!product) throw new ApiError(404, 'Product not found')

  assertPricing(input.price ?? product.price, input.mrp ?? product.mrp)
  const variants = input.variants ? mergeVariants(input.variants, product.variants) : undefined
  if (input.sku || variants) await assertUniqueSkus({ sku: input.sku ?? product.sku, variants: variants ?? product.variants }, id)
  if (input.slug && input.slug !== product.slug && (await Product.exists({ slug: input.slug, _id: { $ne: id } }))) {
    throw new ApiError(409, 'A product with this slug already exists', [], 'DUPLICATE_SLUG')
  }

  const newImages = await uploadFiles((request.files as Express.Multer.File[] | undefined) ?? [])
  const removed = product.images.filter((url) => removeImages.includes(url))
  const images = [...product.images.filter((url) => !removeImages.includes(url)), ...newImages]
  const requestedThumbnail = request.body.thumbnailIndex !== undefined ? images[Math.max(Number(request.body.thumbnailIndex) || 0, 0)] : undefined
  const thumbnailImage = requestedThumbnail ?? (images.includes(product.thumbnailImage) ? product.thumbnailImage : images[0] ?? '')

  const { variants: _ignored, ...fields } = input
  product.set({ ...fields, images, thumbnailImage })
  if (variants) product.set('variants', variants)
  try {
    await product.save()
  } catch (error) {
    await Promise.all(newImages.map(destroyMediaByUrl))
    throw error
  }
  await Promise.all(removed.map(destroyMediaByUrl))
  sendSuccess(response, product, 'Product updated')
}))

adminProductsRouter.patch('/:id/status', asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const { status } = z.object({ status: z.enum(productStatuses) }).parse(request.body)
  const product = await Product.findByIdAndUpdate(id, { $set: { status } }, { new: true, runValidators: true })
  if (!product) throw new ApiError(404, 'Product not found')
  sendSuccess(response, product, 'Product status updated')
}))

/** Sets (`stock`) or adjusts (`delta`) stock for the product or one variant, as a single atomic update. */
adminProductsRouter.patch('/:id/inventory', asyncHandler(async (request, response) => {
  const id = new Types.ObjectId(objectIdSchema.parse(request.params.id))
  const input = inventorySchema.parse(request.body)
  const exists = await Product.findById(id).select('variants._id').lean()
  if (!exists) throw new ApiError(404, 'Product not found')

  let result
  if ('variantId' in input) {
    const variantId = new Types.ObjectId(input.variantId)
    if (!exists.variants.some((variant) => variant._id.equals(variantId))) throw new ApiError(404, 'Variant not found')
    const nextStock = 'stock' in input ? input.stock : { $add: ['$$v.stock', input.delta] }
    result = await Product.updateOne(
      { _id: id, variants: { $elemMatch: { _id: variantId, ...('delta' in input ? { stock: { $gte: -input.delta } } : {}) } } },
      [
        { $set: { variants: { $map: { input: '$variants', as: 'v', in: { $cond: [{ $eq: ['$$v._id', variantId] }, { $mergeObjects: ['$$v', { stock: nextStock }] }, '$$v'] } } } } },
        { $set: { stock: { $sum: { $map: { input: { $filter: { input: '$variants', as: 'v', cond: { $ne: ['$$v.active', false] } } }, as: 'v', in: '$$v.stock' } } } } },
      ],
      { updatePipeline: true },
    )
  } else {
    if (exists.variants.length > 0) throw new ApiError(422, 'This product has variants; update stock per variant', [], 'VARIANT_REQUIRED')
    result = 'stock' in input
      ? await Product.updateOne({ _id: id }, { $set: { stock: input.stock } })
      : await Product.updateOne({ _id: id, stock: { $gte: -input.delta } }, { $inc: { stock: input.delta } })
  }
  if (result.matchedCount === 0) throw new ApiError(422, 'Stock cannot go below zero', [], 'INVALID_STOCK')
  sendSuccess(response, await Product.findById(id).lean(), 'Inventory updated')
}))

adminProductsRouter.delete('/:id/images', asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const { url } = z.object({ url: z.string().min(1).max(500) }).parse(request.body)
  const product = await Product.findById(id)
  if (!product) throw new ApiError(404, 'Product not found')
  if (!product.images.includes(url)) throw new ApiError(404, 'Image not found on this product')
  product.images = product.images.filter((image) => image !== url)
  if (product.thumbnailImage === url) product.thumbnailImage = product.images[0] ?? ''
  await product.save()
  await destroyMediaByUrl(url)
  sendSuccess(response, product, 'Image removed')
}))

/** Products referenced by orders are archived (history must stay intact); others are permanently deleted. */
adminProductsRouter.delete('/:id', asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const product = await Product.findById(id)
  if (!product) throw new ApiError(404, 'Product not found')
  if (await Order.exists({ 'items.productId': product._id })) {
    product.status = 'ARCHIVED'
    await product.save()
    sendSuccess(response, { deleted: false, archived: true, product }, 'Product has orders, so it was archived instead of deleted')
    return
  }
  await product.deleteOne()
  await Promise.all(product.images.map(destroyMediaByUrl))
  sendSuccess(response, { deleted: true, archived: false }, 'Product deleted')
}))
