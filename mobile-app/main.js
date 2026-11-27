import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'
import { Geolocation } from '@capacitor/geolocation'
import './style.css'

const android = Capacitor.getPlatform() === 'android'
const tracking = registerPlugin('AttendanceTracking')
const base = ((android ? import.meta.env.VITE_ANDROID_API_URL : import.meta.env.VITE_API_URL) || '').replace(/\/$/, '')
document.querySelector('#app').innerHTML = `
  <main><h1>Teacher attendance</h1>
  <form id="login"><label>Email<input name="email" type="email" required autocomplete="username"></label>
  <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
  <button>Sign in</button></form>
  <section id="shift" hidden><h2 id="state"></h2>
  <button id="in">Check-In</button><button id="out">Check-Out</button>
  <button id="retry">Resume tracking</button><button id="logout">Sign out</button></section>
  <p id="status" role="status"></p></main>`
const get = id => document.getElementById(id)
let token = localStorage.getItem('teacher-token')
let shift = null
let watch
let timer
let latest
let busy = false
let active = false
let ready = false
let sending = false
const status = message => { get('status').textContent = message }

function render() {
  get('login').hidden = Boolean(token)
  get('shift').hidden = !token
  get('state').textContent = !ready ? 'Attendance status unavailable' : shift ? 'Checked in' : 'Checked out'
  get('in').disabled = busy || !ready || Boolean(shift)
  get('out').disabled = busy || !ready || !shift
  get('retry').hidden = ready && (!shift || active)
  get('retry').disabled = busy
  get('logout').disabled = busy || !ready || Boolean(shift)
}
async function api(path, body, credential = token) {
  const headers = credential ? { Authorization: 'Bearer ' + credential } : {}
  if (body) headers['Content-Type'] = 'application/json'
  if (android) {
    const response = await CapacitorHttp.request({
      url: base + '/api/' + path, method: body ? 'POST' : 'GET', headers, data: body,
      connectTimeout: 10000, readTimeout: 10000, disableRedirects: true
    })
    if (response.status >= 300) {
      throw Object.assign(new Error(response.data?.error || 'Request failed.'), { status: response.status })
    }
    return response.data
  }
  const response = await fetch(base + '/api/' + path, {
    headers, method: body ? 'POST' : 'GET', body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  })
  if (!response.ok) throw Object.assign(new Error((await response.json()).error), { status: response.status })
  if (response.status !== 204) return response.json()
}
const options = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
const coords = fix => ({ latitude: fix.coords.latitude, longitude: fix.coords.longitude })
async function position() {
  if (android && (await Geolocation.requestPermissions()).location !== 'granted') {
    throw new Error('Enable precise location permission to record attendance.')
  }
  return coords(await Geolocation.getCurrentPosition(options))
}
async function stop() {
  clearInterval(timer)
  if (watch !== undefined) await Geolocation.clearWatch({ id: watch })
  watch = undefined
  latest = undefined
  active = false
  if (android) await tracking.stop()
}
async function recover(error) {
  if (error.status === 401) {
    token = null
    localStorage.removeItem('teacher-token')
    shift = null
    ready = false
    await stop()
  }
  if (error.status === 409) {
    await stop()
    ready = false
    shift = await api('shift')
    ready = true
  }
  status(error.message)
  render()
}
async function start() {
  if (!shift || active) return
  if (android) {
    const current = await tracking.status()
    if (current.shiftId !== shift.id) {
      await position()
      await tracking.start({ base, token, shiftId: shift.id })
    }
    status('Android tracking is active. See the tracking notification for updates.')
  } else {
    const shiftId = shift.id
    watch = await Geolocation.watchPosition(options, (fix, error) => {
      if (error) { latest = undefined; status(error.message) }
      if (fix) latest = fix
    })
    timer = setInterval(async () => {
      if (busy || sending || !latest || shift?.id !== shiftId) return
      if (Date.now() - latest.timestamp > 60000) {
        status('Waiting for a current GPS fix.')
        return
      }
      sending = true
      try {
        await api('location', { ...coords(latest), shiftId })
        status('Location sent at ' + new Date().toLocaleTimeString())
      } catch (error) {
        try { await recover(error) } catch (failure) { status(failure.message); render() }
      } finally { sending = false }
    }, 15000)
    status('Keep this page open to send location updates.')
  }
  active = true
}
async function sync() {
  ready = false
  shift = await api('shift')
  ready = true
  if (shift) await start()
  else { await stop(); status('') }
}
async function run(task) {
  if (busy) return
  busy = true
  render()
  const submit = get('login').querySelector('button')
  submit.disabled = true
  try { await task() } catch (error) {
    try { await recover(error) } catch (failure) { status(failure.message) }
  } finally { busy = false; submit.disabled = false; render() }
}
get('login').addEventListener('submit', event => {
  event.preventDefault()
  const credentials = Object.fromEntries(new FormData(event.currentTarget))
  run(async () => {
    if (android && !base) throw new Error('Set VITE_ANDROID_API_URL before building the Android app.')
    const result = await api('login', credentials)
    if (result.user.role !== 'teacher') {
      await api('logout', {}, result.token)
      throw new Error('A teacher account is required.')
    }
    token = result.token
    localStorage.setItem('teacher-token', token)
    get('login').reset()
    await sync()
  })
})
get('in').onclick = () => run(async () => {
  shift = await api('check-in', await position())
  await start()
})
get('out').onclick = () => run(async () => {
  const fix = latest && Date.now() - latest.timestamp <= 20000 ? coords(latest) : await position()
  await api('check-out', { ...fix, shiftId: shift.id })
  shift = null
  await stop()
  status('Checked out.')
})
get('retry').onclick = () => run(sync)
get('logout').onclick = () => run(async () => {
  await api('logout', {})
  await stop()
  localStorage.removeItem('teacher-token')
  token = null
  ready = false
  status('')
})
if (android) document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && token) run(async () => {
    active = false
    await sync()
  })
})
render()
if (token) run(sync)

