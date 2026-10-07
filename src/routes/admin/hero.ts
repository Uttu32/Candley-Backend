import { Router } from 'express'
import { z } from 'zod'
import { HeroSlide, overlayPositions, textAlignments } from '../../models/HeroSlide.js'
import { assertFileContent, destroyMediaByUrl, heroMediaUpload, mediaFolders, uploadMedia } from '../../config/cloudinary.js'
import { asyncHandler } from '../../utils/async-handler.js'
import { ApiError } from '../../utils/api-error.js'
import { sendSuccess } from '../../utils/response.js'
import { mediaUrlSchema, objectIdSchema, safeLinkSchema } from '../../utils/validation.js'

const optionalMedia = z.union([mediaUrlSchema, z.literal('')])
// z.null() must come first: z.coerce.date() would turn null into 1970-01-01.
const optionalDate = z.union([z.null(), z.coerce.date()])

const slideFieldsSchema = z.object({
  heading: z.string().trim().min(2).max(120),
  subheading: z.string().trim().max(220).default(''),
  ctaText: z.string().trim().min(2).max(40),
  ctaUrl: safeLinkSchema,
  secondaryCta: z.object({ text: z.string().trim().min(2).max(40), url: safeLinkSchema }).nullable(),
  desktopImage: optionalMedia,
  mobileImage: optionalMedia,
  imageAlt: z.string().trim().max(200),
  backgroundVideo: optionalMedia,
  desktopVideo: optionalMedia,
  mobileVideo: optionalMedia,
  posterImage: optionalMedia,
  overlayPosition: z.enum(overlayPositions),
  textAlignment: z.enum(textAlignments),
  overlay: z.object({
    color: z.string().regex(/^#[0-9a-f]{6}$/i, 'Overlay color must be a hex value like #000000'),
    opacity: z.number().min(0).max(1),
  }),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
  startsAt: optionalDate,
  endsAt: optionalDate,
}).strict()

const createSchema = slideFieldsSchema.partial().required({ heading: true })
const updateSchema = slideFieldsSchema.partial()
type SlideInput = z.infer<typeof updateSchema>

const mediaFields = ['desktopImage', 'mobileImage', 'backgroundVideo', 'desktopVideo', 'mobileVideo', 'posterImage'] as const

/** Cross-field rules, checked against the slide as it will be stored. */
const assertConsistent = (slide: SlideInput) => {
  const problems: string[] = []
  const desktopVideo = slide.desktopVideo || slide.backgroundVideo
  if (slide.mobileImage && !slide.desktopImage && !desktopVideo) problems.push('mobileImage requires a desktopImage or desktop video')
  if (slide.mobileVideo && !desktopVideo) problems.push('mobileVideo requires a desktop video')
  if (slide.posterImage && !desktopVideo && !slide.mobileVideo) problems.push('posterImage is only used with a video')
  if (slide.startsAt && slide.endsAt && slide.endsAt <= slide.startsAt) problems.push('endsAt must be after startsAt')
  if (problems.length) throw new ApiError(400, problems[0]!, problems.map((message) => ({ message })), 'INVALID_SLIDE')
}

/** Keeps the legacy `backgroundVideo` field equal to `desktopVideo` for older clients. */
const syncLegacyVideo = (input: SlideInput) => {
  if (input.desktopVideo !== undefined) return { ...input, backgroundVideo: input.desktopVideo }
  if (input.backgroundVideo !== undefined) return { ...input, desktopVideo: input.backgroundVideo }
  return input
}

const nextSortOrder = async () => ((await HeroSlide.findOne().sort({ sortOrder: -1 }).select('sortOrder').lean())?.sortOrder ?? 0) + 1

export const adminHeroRouter = Router()

adminHeroRouter.get('/', asyncHandler(async (_request, response) => {
  sendSuccess(response, await HeroSlide.find().sort({ sortOrder: 1, createdAt: 1 }).lean())
}))

adminHeroRouter.get('/:id', asyncHandler(async (request, response) => {
  const slide = await HeroSlide.findById(objectIdSchema.parse(request.params.id)).lean()
  if (!slide) throw new ApiError(404, 'Hero slide not found')
  sendSuccess(response, slide)
}))

adminHeroRouter.post('/', asyncHandler(async (request, response) => {
  const input = syncLegacyVideo(createSchema.parse(request.body))
  assertConsistent(input)
  const slide = await HeroSlide.create({ ...input, imageAlt: input.imageAlt || input.heading, sortOrder: input.sortOrder ?? (await nextSortOrder()) })
  sendSuccess(response, slide, 'Hero slide created', 201)
}))

/**
 * Sets the display order. `ids` must list every slide exactly once; positions become 1..n.
 * Declared before `/:id` routes so "order" is not parsed as an id.
 */
adminHeroRouter.put('/order', asyncHandler(async (request, response) => {
  const { ids } = z.object({ ids: z.array(objectIdSchema).min(1).max(100) }).parse(request.body)
  if (new Set(ids).size !== ids.length) throw new ApiError(400, 'ids must not contain duplicates', [], 'VALIDATION_ERROR')
  const existing = await HeroSlide.find().select('_id').lean()
  const known = new Set(existing.map((slide) => String(slide._id)))
  if (existing.length !== ids.length || ids.some((id) => !known.has(id))) {
    throw new ApiError(409, 'ids must include every hero slide exactly once', [], 'ORDER_MISMATCH')
  }
  await HeroSlide.bulkWrite(ids.map((id, index) => ({ updateOne: { filter: { _id: id }, update: { $set: { sortOrder: index + 1 } } } })))
  sendSuccess(response, await HeroSlide.find().sort({ sortOrder: 1, createdAt: 1 }).lean(), 'Hero slides reordered')
}))

adminHeroRouter.patch('/:id', asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const input = syncLegacyVideo(updateSchema.parse(request.body))
  const slide = await HeroSlide.findById(id)
  if (!slide) throw new ApiError(404, 'Hero slide not found')
  const previousMedia = Object.fromEntries(mediaFields.map((field) => [field, slide[field]]))
  assertConsistent({ ...(slide.toObject() as SlideInput), ...input })
  slide.set(input)
  // Images always need alt text; fall back to the heading rather than rejecting edits to legacy slides.
  if (!slide.imageAlt) slide.imageAlt = slide.heading
  await slide.save()
  // Clean up media that was replaced or cleared, unless still referenced by another field.
  const current = new Set(mediaFields.map((field) => slide[field]))
  await Promise.all(mediaFields.filter((field) => input[field] !== undefined && previousMedia[field] && !current.has(previousMedia[field]!)).map((field) => destroyMediaByUrl(previousMedia[field])))
  sendSuccess(response, slide, 'Hero slide updated')
}))

adminHeroRouter.post('/:id/activate', asyncHandler(async (request, response) => {
  const slide = await HeroSlide.findByIdAndUpdate(objectIdSchema.parse(request.params.id), { $set: { active: true } }, { new: true })
  if (!slide) throw new ApiError(404, 'Hero slide not found')
  sendSuccess(response, slide, 'Hero slide activated')
}))

adminHeroRouter.post('/:id/deactivate', asyncHandler(async (request, response) => {
  const slide = await HeroSlide.findByIdAndUpdate(objectIdSchema.parse(request.params.id), { $set: { active: false } }, { new: true })
  if (!slide) throw new ApiError(404, 'Hero slide not found')
  sendSuccess(response, slide, 'Hero slide deactivated')
}))

const imageTargets = ['desktopImage', 'mobileImage', 'posterImage'] as const
const videoTargets = ['desktopVideo', 'mobileVideo'] as const

/** Uploads an image (existing endpoint) or a video file up to 40 MB to a slide field. */
const uploadToSlide = (kind: 'image' | 'video') => asyncHandler(async (request, response) => {
  const id = objectIdSchema.parse(request.params.id)
  const target = z.enum(kind === 'image' ? imageTargets : videoTargets).parse(request.body.target ?? (kind === 'image' ? 'desktopImage' : 'desktopVideo'))
  const file = request.file
  if (!file) throw new ApiError(422, `A ${kind} file is required`)
  assertFileContent(file, kind)
  const slide = await HeroSlide.findById(id)
  if (!slide) throw new ApiError(404, 'Hero slide not found')
  const uploaded = await uploadMedia(file.buffer, mediaFolders.hero, kind)
  const previous = slide[target]
  slide.set(syncLegacyVideo({ [target]: uploaded.secure_url }))
  if (!slide.imageAlt) slide.imageAlt = slide.heading
  await slide.save()
  await destroyMediaByUrl(previous)
  sendSuccess(response, slide, kind === 'image' ? 'Hero image updated' : 'Hero video updated')
})

adminHeroRouter.post('/:id/image', heroMediaUpload.single('image'), uploadToSlide('image'))
adminHeroRouter.post('/:id/video', heroMediaUpload.single('video'), uploadToSlide('video'))

adminHeroRouter.delete('/:id', asyncHandler(async (request, response) => {
  const slide = await HeroSlide.findByIdAndDelete(objectIdSchema.parse(request.params.id))
  if (!slide) throw new ApiError(404, 'Hero slide not found')
  await Promise.all([...new Set(mediaFields.map((field) => slide[field]))].map(destroyMediaByUrl))
  sendSuccess(response, null, 'Hero slide deleted')
}))
