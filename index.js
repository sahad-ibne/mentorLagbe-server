import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { MongoClient, ObjectId } from 'mongodb'

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
  const tution = req.body
  const result = await tutions.insertOne(tution)
  res.send(result)
})

app.delete('/tutions/:id', async (req, res) => {
  const id = req.params.id
  const query = { _id: new ObjectId(id) }
  const result = await tutions.deleteOne(query)
  res.send(result)
})

// application related api
app.post('/applications', async (req, res) => {
  const application = req.body
  const result = await application.insertOne(application)
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
