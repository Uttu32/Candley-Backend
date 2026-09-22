import mongoose from 'mongoose'
import dotenv from 'dotenv'

dotenv.config()

const MONGO_URI = process.env.MONGO_URI!

async function fixIndexes() {
    try {
        await mongoose.connect(MONGO_URI)

        console.log('Connected to MongoDB')

        const collection = mongoose.connection.collection('products')

        // Remove the old unique variants.sku index
        try {
            await collection.dropIndex('variants.sku_1')
            console.log('Removed variants.sku_1 index')
        } catch (error: any) {
            if (error.codeName === 'IndexNotFound') {
                console.log('variants.sku_1 index does not exist')
            } else {
                throw error
            }
        }

        // Create sparse unique index
        await collection.createIndex(
            { 'variants.sku': 1 },
            {
                name: 'variants.sku_1',
                unique: true,
                sparse: true
            }
        )

        console.log('Created sparse unique variants.sku index')

        const indexes = await collection.indexes()

        console.log('\nCurrent indexes:')
        console.log(indexes)

    } catch (error) {
        console.error('Index migration failed:', error)
    } finally {
        await mongoose.disconnect()
    }
}

fixIndexes()