import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import L from 'leaflet'
import { io } from 'socket.io-client'
import 'leaflet/dist/leaflet.css'
import './style.css'

const base = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
async function api(path, token, body) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {}
  if (body) headers['Content-Type'] = 'application/json'
  const response = await fetch(base + '/api/' + path, { method: body ? 'POST' : 'GET',
    headers, body: body && JSON.stringify(body) })
  if (!response.ok) throw Object.assign(new Error((await response.json()).error), { status: response.status })
  if (response.status !== 204) return path === 'apk' ? response.blob() : response.json()
}
function LocationMap({ points }) {
  const element = useRef()
  const map = useRef()
  const markers = useRef(new Map())
  const centered = useRef(false)
  useEffect(() => {
    map.current = L.map(element.current).setView([0, 0], 2)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map.current)
    return () => { map.current.remove(); markers.current.clear(); centered.current = false }
  }, [])
  useEffect(() => {
    const ids = new Set(points.map(point => point.teacher_id))
    for (const [id, marker] of markers.current) {
      if (!ids.has(id)) { marker.remove(); markers.current.delete(id) }
    }
    for (const point of points) {
      const position = [point.latitude, point.longitude]
      let marker = markers.current.get(point.teacher_id)
      if (!marker) {
        marker = L.circleMarker(position, { radius: 9, fillOpacity: 1, color: '#fff', fillColor: '#2358c4' })
          .addTo(map.current)
        markers.current.set(point.teacher_id, marker)
      }
      const label = document.createElement('span')
      label.textContent = point.name + ' · ' + time(point.updated_at)
      marker.setLatLng(position).bindTooltip(label)
    }
    if (points.length && !centered.current) {
      map.current.fitBounds(points.map(p => [p.latitude, p.longitude]), { padding: [30, 30], maxZoom: 15 })
      centered.current = true
    }
    if (!points.length) centered.current = false
  }, [points])
  return <div className="map" ref={element} aria-label="Live teacher map" />
}
const time = value => value ? new Date(value).toLocaleString() : '—'
const coords = (lat, lng) => lat == null ? '—' : lat.toFixed(5) + ', ' + lng.toFixed(5)
function App() {
  const [token, setToken] = useState(sessionStorage.getItem('admin-token'))
  const [rows, setRows] = useState([])
  const [points, setPoints] = useState([])
  const [online, setOnline] = useState(false)
  const [apk, setApk] = useState(false)
  const [message, setMessage] = useState('')
  function clearSession() {
    sessionStorage.removeItem('admin-token')
    setToken(null); setRows([]); setPoints([]); setOnline(false); setApk(false)
  }
  function report(error) {
    if (error.status === 401 || error.status === 403) clearSession()
    setMessage(error.message)
  }
  useEffect(() => {
    if (!token) return
    let active = true
    let request = 0
    const refresh = async () => {
      const version = ++request
      try {
        const data = await api('attendance', token)
        if (active && version === request) setRows(data)
      } catch (error) { if (active && version === request) report(error) }
    }
    const checkApk = () => api('apk/status', token).then(data => active && setApk(data.available))
      .catch(error => active && report(error))
    const socket = io(base || undefined, { auth: { token } })
    socket.on('connect', () => { setOnline(true); refresh(); checkApk() })
    socket.on('disconnect', () => setOnline(false))
    socket.on('connect_error', () => setOnline(false))
    socket.on('locations:snapshot', setPoints)
    socket.on('attendance:changed', refresh)
    refresh()
    checkApk()
    const poll = setInterval(checkApk, 10000)
    return () => { active = false; clearInterval(poll); socket.disconnect() }
  }, [token])
  async function login(event) {
    event.preventDefault()
    try {
      const data = await api('login', null, Object.fromEntries(new FormData(event.currentTarget)))
      if (data.user.role !== 'admin') {
        await api('logout', data.token, {})
        throw new Error('An admin account is required.')
      }
      sessionStorage.setItem('admin-token', data.token)
      setToken(data.token); setMessage('')
    } catch (error) { report(error) }
  }
  async function add(event) {
    event.preventDefault()
    const form = event.currentTarget
    try {
      await api('teachers', token, Object.fromEntries(new FormData(form)))
      form.reset(); setMessage('Teacher added.')
    } catch (error) { report(error) }
  }
  async function download() {
    try {
      const url = URL.createObjectURL(await api('apk', token))
      const link = document.createElement('a')
      link.href = url; link.download = 'attendance.apk'; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { report(error) }
  }
  return <main>
    <header><h1>Attendance dashboard</h1>{token && <button onClick={async () => {
      try { await api('logout', token, {}); clearSession(); setMessage('') } catch (error) { report(error) }
    }}>Sign out</button>}</header>
    {!token ? <section><h2>Admin sign in</h2><form onSubmit={login}>
      <label>Email<input name="email" type="email" required /></label>
      <label>Password<input name="password" type="password" required /></label><button>Sign in</button>
    </form></section> : <>
      <section><h2>Add teacher</h2><form onSubmit={add}>
        <label>Name<input name="name" maxLength="100" required /></label>
        <label>Email<input name="email" type="email" required /></label>
        <label>Initial password<input name="password" type="password" minLength="8" maxLength="128" required /></label>
        <button>Add teacher</button>
      </form></section>
      <section><h2>Teacher app</h2><button disabled={!apk} onClick={download}>Download APK</button>
        {!apk && <p>No APK available.</p>}</section>
      <section><h2>Live teacher locations</h2><p>{online ? points.length + ' checked in' : 'Live connection interrupted'}</p>
        <LocationMap points={points} /></section>
      <section><h2>Attendance</h2><div className="scroll"><table><thead><tr>
        <th>Teacher</th><th>Check-in</th><th>Check-in GPS</th><th>Check-out</th><th>Check-out GPS</th>
      </tr></thead><tbody>{rows.map(row => <tr key={row.id}>
        <td>{row.name}<br/><small>{row.email}</small></td><td>{time(row.check_in)}</td>
        <td>{coords(row.in_lat, row.in_lng)}</td><td>{time(row.check_out)}</td>
        <td>{coords(row.out_lat, row.out_lng)}</td>
      </tr>)}</tbody></table></div>{!rows.length && <p>No attendance recorded.</p>}</section>
    </>}
    <p className="notice" role="status">{message}</p>
  </main>
}
createRoot(document.getElementById('app')).render(<App />)

