import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { timingSafeEqual } from 'node:crypto'
import { MongoClient, ObjectId } from 'mongodb'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

const app = express()
const port = process.env.PORT || 5000

app.use(express.json())
app.use(cors())

const client = new MongoClient(
  `mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@ac-hipotyc-shard-00-00.wwd4izf.mongodb.net:27017,ac-hipotyc-shard-00-01.wwd4izf.mongodb.net:27017,ac-hipotyc-shard-00-02.wwd4izf.mongodb.net:27017/?ssl=true&replicaSet=atlas-2zuwji-shard-0&authSource=admin`
)

export async function connectToMongoDB () {
  try {
    await client.connect()
    console.log('You successfully connected to MongoDB!')
    return client
  } catch (err) {
    console.dir(err)
  }
}
const connectedClient = await connectToMongoDB()

const database = connectedClient.db('mentorLagbe')
const users = database.collection('user')
const tutions = database.collection('tution')
const applications = database.collection('applications')
const payments = database.collection('payments')

await payments.createIndex({ sessionId: 1 }, { unique: true })

const isValidInternalApiSecret = providedSecret => {
  const expected = process.env.INTERNAL_API_SECRET
  if (!expected || !providedSecret) return false

  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(providedSecret)
  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  )
}

app.get('/users', async (req, res) => {
  const cursor = users.find({})
  const result = await cursor.toArray()
  res.send(result)
})

app.get('/', (req, res) => {
  res.send('Hire loop is looping')
})

app.get('/tutions', async (req, res) => {
  const query = {}

  if (req.query.subject) {
    query.subject = {
      $regex: req.query.subject,
      $options: 'i'
    }
  }

  if (req.query.classLevel) {
    query.classLevel = {
      $regex: req.query.classLevel,
      $options: 'i'
    }
  }

  if (req.query.mode) {
    query.mode = {
      $regex: `^${req.query.mode}$`,
      $options: 'i'
    }
  }

  const cursor = tutions.find(query)
  const result = await cursor.toArray()

  res.send(result)
})

app.post('/tutions', async (req, res) => {
  if (!process.env.INTERNAL_API_SECRET) {
    return res.status(503).json({
      message: 'Internal API authentication is not configured.'
    })
  }
  if (!isValidInternalApiSecret(req.get('x-internal-api-secret'))) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const tution = req.body || {}
  const tutorEmail = String(tution.tutorEmail || tution.email || '')
    .trim()
    .toLowerCase()
  if (!tutorEmail) {
    return res.status(400).json({ message: 'Tutor email is required.' })
  }

  const foundUser = await users.findOne({
    email: tutorEmail,
    role: 'tutor'
  })
  if (!foundUser) {
    return res.status(404).json({ message: 'Tutor account was not found.' })
  }

  const isPro = String(foundUser.plan || '').toLowerCase() === 'pro'
  if (!isPro) {
    const count = await tutions.countDocuments({
      $or: [{ tutorEmail: tutorEmail }, { email: tutorEmail }]
    })

    if (count >= 2) {
      return res.status(403).json({
        message: 'You can post a maximum of 2 tuitions.'
      })
    }
  }

  const newTution = {
    ...tution,
    tutorEmail,
    tutorName: foundUser.name || tution.tutorName || '',
    tutorPlan: isPro ? 'pro' : 'free',
    createdAt: new Date()
  }

  const result = await tutions.insertOne(newTution)
  res.status(201).json(result)
})

app.post('/payments/checkout-verify', async (req, res) => {
  const configuredSecret = process.env.INTERNAL_API_SECRET
  const providedSecret = req.get('x-internal-api-secret')
  if (!configuredSecret) {
    return res.status(503).json({
      success: false,
      message: 'Payment verification is not configured.'
    })
  }
  if (!isValidInternalApiSecret(providedSecret)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' })
  }

  const { sessionId, userId, email } = req.body || {}
  if (
    typeof sessionId !== 'string' ||
    typeof userId !== 'string' ||
    !ObjectId.isValid(userId) ||
    typeof email !== 'string' ||
    !email.trim()
  ) {
    return res.status(400).json({
      success: false,
      message: 'Session ID and valid tutor account details are required.'
    })
  }

  try {
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId)
    const metadata = checkoutSession.metadata || {}
    const normalizedEmail = email.trim().toLowerCase()

    if (
      checkoutSession.status !== 'complete' ||
      checkoutSession.payment_status !== 'paid' ||
      checkoutSession.mode !== 'payment' ||
      metadata.userRole !== 'tutor' ||
      metadata.plan !== 'pro' ||
      metadata.userId !== userId ||
      metadata.userEmail?.toLowerCase() !== normalizedEmail ||
      checkoutSession.client_reference_id !== userId
    ) {
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed.'
      })
    }

    const userQuery = {
      _id: new ObjectId(userId),
      email: normalizedEmail,
      role: 'tutor'
    }
    const user = await users.findOne(userQuery, { projection: { _id: 1 } })
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Tutor account was not found.'
      })
    }

    const payment = {
      sessionId,
      status: checkoutSession.status,
      payment_status: checkoutSession.payment_status,
      customer_email:
        checkoutSession.customer_details?.email ||
        checkoutSession.customer_email ||
        normalizedEmail,
      userId,
      payment_intent:
        typeof checkoutSession.payment_intent === 'string'
          ? checkoutSession.payment_intent
          : checkoutSession.payment_intent?.id || null,
      createdAt: new Date()
    }

    let alreadyVerified = false
    try {
      await payments.insertOne(payment)
    } catch (error) {
      if (error?.code !== 11000) throw error

      const existingPayment = await payments.findOne({ sessionId })
      if (!existingPayment || existingPayment.userId !== userId) {
        return res.status(409).json({
          success: false,
          message: 'This checkout session is already linked to another account.'
        })
      }
      alreadyVerified = true
    }

    const updateResult = await users.updateOne(userQuery, {
      $set: {
        plan: 'pro',
        pro: true,
        stripeCustomerId:
          typeof checkoutSession.customer === 'string'
            ? checkoutSession.customer
            : checkoutSession.customer?.id || null,
        planUpdatedAt: new Date()
      }
    })
    if (updateResult.matchedCount !== 1) {
      return res.status(404).json({
        success: false,
        message: 'Tutor account was not found.'
      })
    }

    return res.json({ success: true, alreadyVerified, plan: 'pro' })
  } catch (error) {
    console.error('Payment verification failed:', error)
    return res.status(500).json({
      success: false,
      message: 'Could not verify the payment.'
    })
  }
})

app.delete('/tutions/:id', async (req, res) => {
  const id = req.params.id
  const query = { _id: new ObjectId(id) }
  const result = await tutions.deleteOne(query)
  res.send(result)
})

// application related api
app.post('/applications', async (req, res) => {
  const newApplication = {
    ...req.body,
    status: 'pending',
    createdAt: new Date()
  }
  const result = await applications.insertOne(newApplication)
  res.send(result)
})

app.get('/applications', async (req, res) => {
  const query = {}
  if (req.query.email) {
    query.studentEmail = req.query.email
  }
  const result = await applications.find(query).toArray()
  res.send(result)
})

app.delete('/applications/:id', async (req, res) => {
  const id = req.params.id
  const query = { _id: new ObjectId(id) }
  const result = await applications.deleteOne(query)
  res.send(result)
})

app.patch('/tutions/:id', async (req, res) => {
  try {
    const id = req.params.id
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid tuition ID' })
    }

    const filter = { _id: new ObjectId(id) }
    const updateDoc = {
      $set: {
        ...req.body,
        updatedAt: new Date()
      }
    }

    const result = await tutions.updateOne(filter, updateDoc)
    res.json(result)
  } catch (error) {
    console.error('Update tuition error:', error)
    res.status(500).json({ message: 'Failed to update tuition' })
  }
})

app.listen(port, () => {
  console.log(`Hire loop is running on port ${port}`)
})
