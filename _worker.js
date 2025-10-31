import { connect } from 'cloudflare:sockets'

const CF_FALLBACK_IPS = ['210.61.97.241:81']

export default {
  async fetch(req) {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response('WebSocket Proxy Server', { status: 200 })
    
    const [client, server] = Object.values(new WebSocketPair())
    server.accept()
    handle(server)
    return new Response(null, { status: 101, webSocket: client })
  }
}

async function handle(ws) {
  let rSock, rW, rR, closed = false

  const close = () => {
    if (closed) return
    closed = true
    rW?.releaseLock()
    rR?.releaseLock()
    rSock?.close()
    if (ws.readyState <= 2) ws.close(1000, 'Server closed')
  }

  const str2b = s => Uint8Array.from(s, c => c.charCodeAt(0))

  const parseAddr = a => {
    const i = a.lastIndexOf(':')
    if (i === -1) throw new Error('Invalid address')
    return { h: a.slice(0, i), p: +a.slice(i + 1) }
  }

  const tryConn = async (h, p, fb) => {
    const [host, port] = fb?.split(':') || [h, p]
    const sock = connect({ hostname: host, port: +port })
    if (sock.opened) await sock.opened
    return sock
  }

  const pump = async () => {
    try {
      while (!closed && rR && rSock) {
        const { done, value } = await rR.read()
        if (done) { ws.send('CLOSE'); close(); break }
        value && ws.readyState === 1 && ws.send(value)
      }
    } catch { close() }
  }

  const conn = async (addr, data) => {
    const { h, p } = parseAddr(addr)
    for (const fb of [null, ...CF_FALLBACK_IPS]) {
      try {
        rSock = await tryConn(h, p, fb)
        rW = rSock.writable.getWriter()
        rR = rSock.readable.getReader()
        if (data) await rW.write(str2b(data))
        ws.send('CONNECTED')
        pump()
        return
      } catch { rSock?.close() }
    }
    close()
  }

  ws.addEventListener('message', async e => {
    const d = e.data
    if (typeof d === 'string') {
      if (d.startsWith('CONNECT:')) {
        const [addr, data] = d.slice(8).split('|')
        addr && await conn(addr, data)
      } else if (d.startsWith('DATA:')) {
        rW && await rW.write(str2b(d.slice(5)))
      } else if (d === 'CLOSE') close()
    } else if (d instanceof ArrayBuffer && rW) {
      await rW.write(new Uint8Array(d))
    }
  })

  ws.addEventListener('close', close)
  ws.addEventListener('error', close)
}
