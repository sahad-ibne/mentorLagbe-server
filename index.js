import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { timingSafeEqual } from 'node:crypto'
import { MongoClient, ObjectId } from 'mongodb'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const tutorProPriceId =
  process.env.STRIPE_PRO_PRICE_ID || 'price_1UeV9Z9pnCvIG9dFoAJZUfQ7'
const studentProPriceId =
  process.env.STRIPE_STUDENT_PRO_PRICE_ID || 'price_1UebKQ9pnCvIG9dFKZlN01S5'

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
const sessions = database.collection('session')
const tutions = database.collection('tution')
const applications = database.collection('applications')
const payments = database.collection('payments')

await payments.createIndex({ sessionId: 1 }, { unique: true })
const applicationStatusMigration = await applications.updateMany(
  { status: { $regex: '^approved$', $options: 'i' } },
  { $set: { status: 'accepted' } }
)
if (applicationStatusMigration.modifiedCount > 0) {
  console.log(
    `Migrated ${applicationStatusMigration.modifiedCount} application statuses to accepted.`
  )
}

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

const requireInternalApiSecret = (req, res, next) => {
  if (!process.env.INTERNAL_API_SECRET) {
    return res.status(503).json({
      message: 'Internal API authentication is not configured.'
    })
  }
  if (!isValidInternalApiSecret(req.get('x-internal-api-secret'))) {
    return res.status(401).json({ message: 'Unauthorized' })
  }
  next()
}

app.get('/users', async (req, res) => {
  const cursor = users.find({})
  const result = await cursor.toArray()
  res.send(result)
})

app.get('/', (req, res) => {
  res.send('Hire loop is looping')
})

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization
  if (!authHeader) {
    res.status(401).send({ message: 'Unauthorized' })
    return
  }
  const token = authHeader.split(' ')[1]
  if (!token) {
    res.status(401).send({ message: 'Unauthorized' })
    return
  }
  const query = { token }
  const session = await sessions.findOne(query)
  if (!session) {
    res.status(401).send({ message: 'Unauthorized' })
    return
  }
  const userId = session.userId

  const userQuery = { _id: new ObjectId(userId) }
  const user = await users.findOne(userQuery)
  if (!user) {
    res.status(401).send({ message: 'Unauthorized' })
    return
  }
  req.user = user
  next()
}

app.get('/platform-stats', async (req, res) => {
  try {
    const [verifiedStudents, verifiedTutors, activeTuitions] =
      await Promise.all([
        users.countDocuments({ role: 'student', emailVerified: true }),
        users.countDocuments({ role: 'tutor', emailVerified: true }),
        tutions.countDocuments({
          approvalStatus: 'approved',
          isActive: true
        })
      ])

    res.json({ verifiedStudents, verifiedTutors, activeTuitions })
  } catch (error) {
    console.error('Load platform statistics error:', error)
    res.status(500).json({ message: 'Could not load platform statistics.' })
  }
})

app.get('/tutions/featured', async (req, res) => {
  try {
    const featuredTuitions = await tutions
      .find({ approvalStatus: 'approved', isActive: true })
      .sort({ createdAt: -1, _id: -1 })
      .limit(6)
      .toArray()

    res.json(featuredTuitions)
  } catch (error) {
    console.error('Load featured tuitions error:', error)
    res.status(500).json({ message: 'Could not load featured tuitions.' })
  }
})

app.patch('/users/:id/role', requireInternalApiSecret, async (req, res) => {
  try {
    const { id } = req.params
    const { role } = req.body || {}

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid user ID.' })
    }
    if (!['student', 'tutor', 'admin'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role.' })
    }

    const result = await users.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role, updatedAt: new Date() } }
    )

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: 'User not found.' })
    }

    res.json({ success: true, role })
  } catch (error) {
    console.error('Update user role error:', error)
    res.status(500).json({ message: 'Could not update user role.' })
  }
})

app.get('/payments', requireInternalApiSecret, async (req, res) => {
  try {
    const records = await payments.find({}).sort({ createdAt: -1 }).toArray()
    const completeRecords = await Promise.all(
      records.map(async payment => {
        if (typeof payment.amountTotal === 'number' || !payment.sessionId) {
          return payment
        }

        const checkoutSession = await stripe.checkout.sessions.retrieve(
          payment.sessionId
        )
        const stripeDetails = {
          amountTotal: checkoutSession.amount_total,
          currency: checkoutSession.currency || 'usd',
          transactionId:
            typeof checkoutSession.payment_intent === 'string'
              ? checkoutSession.payment_intent
              : checkoutSession.payment_intent?.id || null,
          paymentDate: checkoutSession.created
            ? new Date(checkoutSession.created * 1000)
            : payment.paymentDate || payment.createdAt || null
        }

        await payments.updateOne({ _id: payment._id }, { $set: stripeDetails })
        return { ...payment, ...stripeDetails }
      })
    )

    const userIds = [
      ...new Set(
        completeRecords
          .map(payment => String(payment.userId || ''))
          .filter(id => ObjectId.isValid(id))
      )
    ].map(id => new ObjectId(id))

    const paymentUsers = userIds.length
      ? await users.find({ _id: { $in: userIds } }).toArray()
      : []
    const usersById = new Map(
      paymentUsers.map(user => [user._id.toString(), user])
    )

    res.json({
      payments: completeRecords.map(payment => {
        const user = usersById.get(String(payment.userId || ''))
        return {
          _id: payment._id.toString(),
          userName: payment.userName || user?.name || '',
          email: payment.email || payment.customer_email || user?.email || '',
          role: payment.role || user?.role || 'tutor',
          planName: payment.planName || payment.plan || 'Pro',
          amountTotal: payment.amountTotal ?? null,
          currency: payment.currency || 'usd',
          transactionId:
            payment.transactionId ||
            payment.payment_intent ||
            payment.sessionId ||
            '',
          sessionId: payment.sessionId || '',
          paymentDate: payment.paymentDate || payment.createdAt || null
        }
      })
    })
  } catch (error) {
    console.error('Load payments error:', error)
    res.status(500).json({ message: 'Could not load payments.' })
  }
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
      message: 'Session ID and valid account details are required.'
    })
  }

  try {
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId)
    const metadata = checkoutSession.metadata || {}
    const normalizedEmail = email.trim().toLowerCase()
    const userRole = metadata.userRole
    const expectedPriceId =
      userRole === 'student'
        ? studentProPriceId
        : userRole === 'tutor'
        ? tutorProPriceId
        : null
    const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, {
      limit: 2
    })
    const purchasedPriceId =
      lineItems.data.length === 1
        ? typeof lineItems.data[0].price === 'string'
          ? lineItems.data[0].price
          : lineItems.data[0].price?.id
        : null

    if (
      checkoutSession.status !== 'complete' ||
      checkoutSession.payment_status !== 'paid' ||
      checkoutSession.mode !== 'payment' ||
      !expectedPriceId ||
      metadata.plan !== 'pro' ||
      metadata.userId !== userId ||
      metadata.userEmail?.toLowerCase() !== normalizedEmail ||
      checkoutSession.client_reference_id !== userId ||
      purchasedPriceId !== expectedPriceId ||
      lineItems.data[0]?.quantity !== 1
    ) {
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed.'
      })
    }

    const userQuery = {
      _id: new ObjectId(userId),
      email: normalizedEmail,
      role: userRole
    }
    const user = await users.findOne(userQuery, {
      projection: { _id: 1, name: 1, email: 1, role: 1 }
    })
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Account was not found.'
      })
    }

    const payment = {
      sessionId,
      status: checkoutSession.status,
      payment_status: checkoutSession.payment_status,
      userName: user.name || '',
      email: normalizedEmail,
      role: userRole,
      planName: userRole === 'student' ? 'Student Pro' : 'Tutor Pro',
      amountTotal: checkoutSession.amount_total,
      currency: checkoutSession.currency || 'usd',
      transactionId:
        typeof checkoutSession.payment_intent === 'string'
          ? checkoutSession.payment_intent
          : checkoutSession.payment_intent?.id || null,
      paymentDate: checkoutSession.created
        ? new Date(checkoutSession.created * 1000)
        : new Date(),
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
        message: 'Account was not found.'
      })
    }

    return res.json({
      success: true,
      alreadyVerified,
      plan: 'pro',
      role: userRole
    })
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
  res.send(
    result.map(application => ({
      ...application,
      status:
        String(application.status || '').toLowerCase() === 'approved'
          ? 'accepted'
          : application.status
    }))
  )
})

app.delete('/applications/:id', async (req, res) => {
  const id = req.params.id
  const query = { _id: new ObjectId(id) }
  const result = await applications.deleteOne(query)
  res.send(result)
})

app.patch(
  '/tutions/:id/approval',
  requireInternalApiSecret,
  async (req, res) => {
    try {
      const { id } = req.params
      const { approvalStatus } = req.body || {}

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid tuition ID.' })
      }
      if (!['approved', 'rejected'].includes(approvalStatus)) {
        return res
          .status(400)
          .json({ message: 'Status must be approved or rejected.' })
      }

      const result = await tutions.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            approvalStatus,
            isActive: approvalStatus === 'approved',
            updatedAt: new Date()
          }
        }
      )

      if (result.matchedCount === 0) {
        return res.status(404).json({ message: 'Tuition not found.' })
      }

      res.json({ success: true, approvalStatus })
    } catch (error) {
      console.error('Update tuition approval error:', error)
      res.status(500).json({ message: 'Could not update tuition approval.' })
    }
  }
)

app.patch('/tutions/:id', async (req, res) => {
  try {
    const id = req.params.id
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid tuition ID' })
    }

    const filter = { _id: new ObjectId(id) }
    const allowedFields = [
      'title',
      'subject',
      'classLevel',
      'mode',
      'location',
      'monthlyFee',
      'daysPerWeek',
      'description',
      'status',
      'isActive'
    ]
    const update = Object.fromEntries(
      Object.entries(req.body || {}).filter(([key]) =>
        allowedFields.includes(key)
      )
    )
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: 'No editable fields provided.' })
    }

    const updateDoc = {
      $set: {
        ...update,
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
