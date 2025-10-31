/**
 * Cloudflare Workers WebSocket 代理服务端
 * 自动检测 CF 托管网站并使用中转 IP 重连
 */

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

// Cloudflare 中转 IP（支持 IP 或 IP:端口）
const CF_FALLBACK_IPS = [
  '210.61.97.241:81', // 支持这种写法
];

import { connect } from 'cloudflare:sockets';

export default {
  async fetch(request, env, ctx) {
    try {
      // 客户端认证token，留空则不启用
      const token = '';
      const upgradeHeader = request.headers.get('Upgrade');
      
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        const url = new URL(request.url);
        if (url.pathname === '/') {
          return new Response('WebSocket Proxy Server with CF Fallback', { 
            status: 200,
            headers: { 'Content-Type': 'text/plain' }
          });
        }
        return new Response('Expected WebSocket', { status: 426 });
      }

      if (token) {
        const clientToken = request.headers.get('Sec-WebSocket-Protocol');
        if (clientToken !== token) {
          console.log('Token 验证失败');
          return new Response('Unauthorized', { status: 401 });
        }
      }

      return await handleWebSocketConnection(request, token);
      
    } catch (err) {
      console.error('请求处理错误:', err);
      return new Response(err.toString(), { status: 500 });
    }
  },
};

async function handleWebSocketConnection(request, token) {
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  server.accept();

  handleSession(server).catch(err => {
    console.error('会话处理错误:', err);
    safeCloseWebSocket(server);
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
    ...(token && { headers: { 'Sec-WebSocket-Protocol': token } })
  });
}

async function handleSession(webSocket) {
  let remoteSocket = null;
  let remoteWriter = null;
  let remoteReader = null;
  let isClosed = false;
  let isReading = false;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;

    if (remoteWriter) {
      try { remoteWriter.releaseLock(); } catch (e) {}
      remoteWriter = null;
    }

    if (remoteReader) {
      try { remoteReader.releaseLock(); } catch (e) {}
      remoteReader = null;
    }

    if (remoteSocket) {
      try { remoteSocket.close(); } catch (e) {}
      remoteSocket = null;
    }

    safeCloseWebSocket(webSocket);
  };

  const pumpRemoteToWebSocket = async () => {
    if (isReading) return;
    isReading = true;
    
    try {
      while (!isClosed && remoteReader && remoteSocket) {
        const { done, value } = await remoteReader.read();
        
        if (done) {
          sendWebSocketMessage(webSocket, 'CLOSE');
          cleanup();
          break;
        }

        if (value && value.byteLength > 0 && webSocket.readyState === WS_READY_STATE_OPEN) {
          webSocket.send(value);
        } else {
          break;
        }
      }
    } catch (err) {
      if (!isClosed) {
        console.error('读取远程数据失败:', err.message);
        sendWebSocketMessage(webSocket, 'CLOSE');
        cleanup();
      }
    } finally {
      isReading = false;
    }
  };

  const parseAddress = (addr) => {
    const lastColon = addr.lastIndexOf(':');
    if (lastColon === -1) throw new Error('无效的地址格式，缺少端口');
    const host = addr.substring(0, lastColon);
    const port = parseInt(addr.substring(lastColon + 1), 10);
    if (isNaN(port) || port < 1 || port > 65535) throw new Error('无效的端口号: ' + port);
    return { host, port };
  };

  const stringToBytes = (str) => {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF;
    return bytes;
  };

  const isCloudflareLimitError = (err) => {
    if (!err || !err.message) return false;
    const msg = err.message.toLowerCase();
    return ['proxy request failed','cannot connect','consider using fetch','cloudflare','network connection'].some(k => msg.includes(k));
  };

  /**
   * 🔧 修复版：支持 fallback IP 带端口
   */
  const tryConnect = async (host, port, fallbackIP = null) => {
    let targetHost = host;
    let targetPort = port;

    if (fallbackIP) {
      if (fallbackIP.includes(':')) {
        const [ip, customPort] = fallbackIP.split(':');
        targetHost = ip;
        targetPort = parseInt(customPort, 10) || port;
      } else {
        targetHost = fallbackIP;
      }
    }

    console.log(`尝试连接: ${targetHost}:${targetPort}${fallbackIP ? ` (中转 for ${host})` : ''}`);

    const socket = connect({
      hostname: targetHost,
      port: targetPort
    });

    if (socket.opened) await socket.opened;
    return socket;
  };

  const connectToRemote = async (targetAddr, firstFrameData) => {
    const { host, port } = parseAddress(targetAddr);
    let lastError = null;
    const attempts = [
      { name: '直连', ip: null },
      ...CF_FALLBACK_IPS.map(ip => ({ name: `中转 ${ip}`, ip }))
    ];

    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      try {
        console.log(`[${i + 1}/${attempts.length}] 连接到目标: ${host}:${port} - ${a.name}`);
        remoteSocket = await tryConnect(host, port, a.ip);
        remoteWriter = remoteSocket.writable.getWriter();
        remoteReader = remoteSocket.readable.getReader();

        if (firstFrameData?.length > 0) {
          const bytes = stringToBytes(firstFrameData);
          await remoteWriter.write(bytes);
        }

        sendWebSocketMessage(webSocket, 'CONNECTED');
        pumpRemoteToWebSocket();
        return;

      } catch (err) {
        console.error(`连接失败 (${a.name}):`, err.message);
        lastError = err;
        if (isCloudflareLimitError(err) && i < attempts.length - 1) continue;
      }
    }
    throw lastError || new Error('所有连接尝试均失败');
  };

  webSocket.addEventListener('message', async (event) => {
    if (isClosed) return;
    const data = event.data;

    try {
      if (typeof data === 'string') {
        if (data.startsWith('CONNECT:')) {
          const content = data.substring(8);
          const i = content.indexOf('|');
          if (i === -1) return sendWebSocketMessage(webSocket, 'ERROR:无效的 CONNECT 消息格式');

          const targetAddr = content.substring(0, i);
          const firstFrame = content.substring(i + 1);
          await connectToRemote(targetAddr, firstFrame);
        } else if (data.startsWith('DATA:')) {
          if (remoteWriter) await remoteWriter.write(stringToBytes(data.substring(5)));
        } else if (data === 'CLOSE') cleanup();
      } else if (data instanceof ArrayBuffer && remoteWriter) {
        await remoteWriter.write(new Uint8Array(data));
      }
    } catch (err) {
      console.error('消息处理错误:', err.message);
      cleanup();
    }
  });

  webSocket.addEventListener('close', cleanup);
  webSocket.addEventListener('error', cleanup);
}

function sendWebSocketMessage(ws, message) {
  try {
    if (ws.readyState === WS_READY_STATE_OPEN) {
      ws.send(message);
      return true;
    }
    return false;
  } catch (err) {
    console.error('发送消息失败:', err.message);
    return false;
  }
}

function safeCloseWebSocket(ws) {
  try {
    if (ws.readyState === WS_READY_STATE_OPEN || ws.readyState === WS_READY_STATE_CLOSING) {
      ws.close(1000, 'Server closed');
    }
  } catch (err) {}
}
