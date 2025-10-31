const CF_FALLBACK_IPS = ['210.61.97.241:81']
import { connect } from 'cloudflare:sockets'

export default {
  async fetch(req) {
    const u = req.headers.get('Upgrade')
    if (!u || u.toLowerCase() !== 'websocket')
      return new Response('WebSocket Proxy Server', { status: 200 })
    const p = new WebSocketPair()
    const [c, s] = Object.values(p)
    s.accept()
    handle(s)
    return new Response(null, { status: 101, webSocket: c })
  }
}

async function handle(ws) {
  let rSock, rW, rR, closed = false
  const close = () => {
    if (closed) return
    closed = true
    try { rW?.releaseLock() } catch {}
    try { rR?.releaseLock() } catch {}
    try { rSock?.close() } catch {}
    safeClose(ws)
  }
  const pump = async () => {
    try {
      while (!closed && rR && rSock) {
        const { done, value } = await rR.read()
        if (done) { send(ws, 'CLOSE'); close(); break }
        if (value?.byteLength && ws.readyState === 1) ws.send(value)
        else break
      }
    } catch { close() }
  }
  const parseAddr = a => {
    const i = a.lastIndexOf(':')
    if (i === -1) throw 0
    return { h: a.slice(0, i), p: +a.slice(i + 1) }
  }

  const str2b = s => {
    const b = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff
    return b
  }

  const tryConn = async (h, p, fb = null) => {
    let targetHost = h, targetPort = p
    if (fb) {
      if (fb.includes(':')) {
        const [ip, cp] = fb.split(':')
        targetHost = ip
        targetPort = +cp || p
      } else targetHost = fb
    }
    const sock = connect({ hostname: targetHost, port: targetPort })
    if (sock.opened) await sock.opened
    return sock
  }

  const conn = async (addr, data) => {
    const { h, p } = parseAddr(addr)
    const list = [{ ip: null }, ...CF_FALLBACK_IPS.map(i => ({ ip: i }))]
    for (const t of list) {
      try {
        rSock = await tryConn(h, p, t.ip)
        rW = rSock.writable.getWriter()
        rR = rSock.readable.getReader()
        if (data?.length) await rW.write(str2b(data))
        send(ws, 'CONNECTED')
        pump()
        return
      } catch { try { rSock?.close() } catch {} }
    }
    close()
  }

  ws.addEventListener('message', async e => {
    const d = e.data
    if (typeof d === 'string') {
      if (d.startsWith('CONNECT:')) {
        const x = d.slice(8), i = x.indexOf('|')
        if (i === -1) return
        await conn(x.slice(0, i), x.slice(i + 1))
      } else if (d.startsWith('DATA:') && rW) await rW.write(str2b(d.slice(5)))
      else if (d === 'CLOSE') close()
    } else if (d instanceof ArrayBuffer && rW) await rW.write(new Uint8Array(d))
  })

  ws.addEventListener('close', close)
  ws.addEventListener('error', close)
}

const send = (ws, m) => { if (ws.readyState === 1) ws.send(m) }
const safeClose = ws => { if (ws.readyState === 1 || ws.readyState === 2) ws.close(1000, 'Server closed') }
