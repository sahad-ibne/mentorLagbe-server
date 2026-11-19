import express from 'express'
import cors from 'cors'
import { MongoClient } from 'mongodb'

const app = express()
const port = process.env.PORT || 5000

const client = new MongoClient(
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wwd4izf.mongodb.net/`
)

app.use(express.json())
app.use(cors())

app.get('/', (req, res) => {
  res.send('Hire loop is looping')
})

app.listen(port, () => {
  console.log(`Hire loop is running on port ${port}`)
})
