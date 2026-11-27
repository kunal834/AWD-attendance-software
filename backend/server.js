import express from 'express'
import cors from 'cors'
import { createServer } from 'node:http'
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { Server } from 'socket.io'

const db = new Database(process.env.DB_PATH || fileURLToPath(new URL('./attendance.sqlite', import.meta.url)))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY, teacher_id INTEGER NOT NULL REFERENCES users(id),
    check_in TEXT NOT NULL, in_lat REAL NOT NULL, in_lng REAL NOT NULL,
    check_out TEXT, out_lat REAL, out_lng REAL, latitude REAL, longitude REAL, updated_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS open_shift ON attendance(teacher_id) WHERE check_out IS NULL;
`)
const emailOf = value => typeof value === 'string' ? value.trim().toLowerCase() : ''
const validEmail = value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
const validPassword = value => typeof value === 'string' && value.length >= 8 && value.length <= 128
function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return salt + ':' + scryptSync(password, salt, 64).toString('hex')
}
const adminEmail = emailOf(process.env.ADMIN_EMAIL)
if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
  if (!validEmail(adminEmail) || !validPassword(process.env.ADMIN_PASSWORD)) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in .env before starting.')
  }
  db.prepare('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)')
    .run('Admin', adminEmail, passwordHash(process.env.ADMIN_PASSWORD), 'admin')
}

const app = express()
const server = createServer(app)
const origins = new Set(['http://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:5173',
  'http://127.0.0.1:5174', 'https://localhost', 'http://localhost', ...(process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean)])
const corsOptions = { origin: (origin, callback) => callback(null, !origin || origins.has(origin)) }
app.use(cors(corsOptions))
app.use(express.json({ limit: '8kb' }))
const io = new Server(server, { cors: corsOptions })
const tokenHash = token => createHash('sha256').update(token).digest('hex')
function session(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return
  return db.prepare(`SELECT users.id, name, email, role, expires FROM sessions
    JOIN users ON users.id = sessions.user_id WHERE token = ? AND expires > ?`)
    .get(tokenHash(token), Date.now())
}
const fail = (res, status, error) => res.status(status).json({ error })
const auth = role => (req, res, next) => {
  req.token = req.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
  req.user = session(req.token)
  if (!req.user) return fail(res, 401, 'Sign in to continue.')
  if (role && req.user.role !== role) return fail(res, 403, 'Access denied.')
  next()
}
const attempts = new Map()
app.post('/api/login', (req, res) => {
  const now = Date.now()
  for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip)
  const entry = attempts.get(req.ip) || { count: 0, until: now + 60_000 }
  if (entry.count >= 20) return fail(res, 429, 'Try again in a minute.')
  entry.count++
  attempts.set(req.ip, entry)
  const { email, password } = req.body || {}
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(emailOf(email))
  if (!user || !validPassword(password) || !timingSafeEqual(Buffer.from(user.password),
    Buffer.from(passwordHash(password, user.password.split(':')[0])))) {
    return fail(res, 401, 'Invalid email or password.')
  }
  const token = randomBytes(32).toString('hex')
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now)
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(tokenHash(token), user.id, now + 604800000)
  res.json({ token, user: session(token) })
})
app.get('/api/me', auth(), (req, res) => res.json(req.user))
app.post('/api/logout', auth(), (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash(req.token))
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.token === req.token) socket.disconnect(true)
  }
  res.sendStatus(204)
})
app.post('/api/teachers', auth('admin'), (req, res) => {
  const { name, password, email: rawEmail } = req.body || {}
  const email = emailOf(rawEmail)
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || !validEmail(email) || !validPassword(password)) {
    return fail(res, 400, 'Enter a name, a valid email, and a password of 8–128 characters.')
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return fail(res, 409, 'Email already in use.')
  const result = db.prepare("INSERT INTO users (name,email,password,role) VALUES (?,?,?,'teacher')")
    .run(name.trim(), email, passwordHash(password))
  res.status(201).json({ id: Number(result.lastInsertRowid), name: name.trim(), email })
})
app.get('/api/attendance', auth('admin'), (req, res) => res.json(db.prepare(`
  SELECT a.*, u.name, u.email FROM attendance a JOIN users u ON u.id=a.teacher_id ORDER BY a.id DESC
`).all()))
const open = db.prepare('SELECT * FROM attendance WHERE teacher_id=? AND check_out IS NULL')
const locations = () => db.prepare(`SELECT a.teacher_id, u.name, a.latitude, a.longitude, a.updated_at
  FROM attendance a JOIN users u ON u.id=a.teacher_id WHERE a.check_out IS NULL`).all()
io.use((socket, next) => {
  const token = socket.handshake.auth?.token
  const user = session(token)
  if (user?.role !== 'admin') return next(new Error('Admin sign-in required.'))
  socket.data.token = token
  socket.data.expires = user.expires
  next()
})
io.on('connection', socket => {
  socket.join('admins')
  socket.emit('locations:snapshot', locations())
  const timer = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.expires - Date.now()))
  socket.on('disconnect', () => clearTimeout(timer))
})
function broadcast(attendanceChanged) {
  io.to('admins').emit('locations:snapshot', locations())
  if (attendanceChanged) io.to('admins').emit('attendance:changed')
}
app.get('/api/shift', auth('teacher'), (req, res) => res.json(open.get(req.user.id) || null))
for (const action of ['check-in', 'check-out', 'location']) {
  app.post('/api/' + action, auth('teacher'), (req, res) => {
    const { latitude, longitude, shiftId } = req.body || {}
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
        !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
      return fail(res, 400, 'Valid latitude and longitude are required.')
    }
    const teacher = req.user.id
    const shift = open.get(teacher)
    const timestamp = new Date().toISOString()
    if (action === 'check-in') {
      if (shift) return fail(res, 409, 'Already checked in.')
      db.prepare(`INSERT INTO attendance (teacher_id,check_in,in_lat,in_lng,latitude,longitude,updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(teacher, timestamp, latitude, longitude, latitude, longitude, timestamp)
      broadcast(true)
      return res.status(201).json(open.get(teacher))
    }
    if (!shift || shift.id !== shiftId) return fail(res, 409, 'This shift is closed or has changed.')
    if (action === 'check-out') {
      db.prepare('UPDATE attendance SET check_out=?,out_lat=?,out_lng=? WHERE id=?')
        .run(timestamp, latitude, longitude, shiftId)
    } else {
      db.prepare('UPDATE attendance SET latitude=?,longitude=?,updated_at=? WHERE id=?')
        .run(latitude, longitude, timestamp, shiftId)
    }
    broadcast(action === 'check-out')
    res.sendStatus(204)
  })
}
const apk = fileURLToPath(new URL('../apk-releases/attendance.apk', import.meta.url))
app.get('/api/apk/status', auth('admin'), (req, res) => res.json({ available: existsSync(apk) }))
app.get('/api/apk', auth('admin'), (req, res, next) => {
  res.download(apk, 'attendance.apk', error => { if (error) next(error) })
})
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error)
  if (error.status === 404) return fail(res, 404, 'APK unavailable.')
  if (error.status === 400 || error.status === 413) return fail(res, error.status, 'Invalid request body.')
  console.error(error)
  fail(res, 500, 'Server error.')
})
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0',
  () => console.log('Attendance API listening on port', server.address().port))

