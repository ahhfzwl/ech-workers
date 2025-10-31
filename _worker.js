/**
 * Cloudflare Workers WebSocket 代理服务端
 * 自动检测 CF 托管网站并使用中转 IP 重连
 */

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

// Cloudflare 中转 IP
const CF_FALLBACK_IPS = [
  '47.245.85.72',  // 中转
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
    if (isReading) {
      console.warn('已经在读取数据，跳过重复调用');
      return;
    }
    
    isReading = true;
    
    try {
      console.log('开始读取远程数据流');
      
      while (!isClosed && remoteReader && remoteSocket) {
        const { done, value } = await remoteReader.read();
        
        if (done) {
          console.log('远程连接正常关闭');
          sendWebSocketMessage(webSocket, 'CLOSE');
          cleanup();
          break;
        }

        if (value && value.byteLength > 0) {
          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            webSocket.send(value);
          } else {
            console.log('WebSocket 已关闭，停止转发');
            break;
          }
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
    if (addr.startsWith('[')) {
      const closeBracket = addr.indexOf(']');
      if (closeBracket === -1) {
        throw new Error('无效的 IPv6 地址格式');
      }
      const host = addr.substring(1, closeBracket);
      const port = parseInt(addr.substring(closeBracket + 2), 10);
      return { host, port };
    }

    const lastColon = addr.lastIndexOf(':');
    if (lastColon === -1) {
      throw new Error('无效的地址格式，缺少端口');
    }

    const host = addr.substring(0, lastColon);
    const port = parseInt(addr.substring(lastColon + 1), 10);
    
    if (isNaN(port) || port < 1 || port > 65535) {
      throw new Error('无效的端口号: ' + port);
    }

    return { host, port };
  };

  const stringToBytes = (str) => {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      bytes[i] = str.charCodeAt(i) & 0xFF;
    }
    return bytes;
  };

  /**
   * 检测是否为 Cloudflare 限制错误
   */
  const isCloudflareLimitError = (err) => {
    if (!err || !err.message) return false;
    
    const errMsg = err.message.toLowerCase();
    
    // Cloudflare Workers 特定错误关键词
    const cfErrorKeywords = [
      'proxy request failed',
      'cannot connect to the specified',
      'consider using fetch',
      'cloudflare',
      'network connection to',
    ];
    
    return cfErrorKeywords.some(keyword => errMsg.includes(keyword));
  };

  /**
   * 尝试建立连接（带中转 IP 重试）
   */
  const tryConnect = async (host, port, fallbackIP = null) => {
    const targetHost = fallbackIP || host;
    
    console.log(`尝试连接: ${targetHost}:${port}${fallbackIP ? ` (中转 IP for ${host})` : ''}`);
    
    const socket = connect({
      hostname: targetHost,
      port: port
    });

    if (socket.opened) {
      await socket.opened;
    }
    
    return socket;
  };

  /**
   * 建立到目标服务器的连接（自动重试中转 IP）
   */
  const connectToRemote = async (targetAddr, firstFrameData) => {
    const { host, port } = parseAddress(targetAddr);
    let lastError = null;
    
    // 尝试列表：先直连，失败后尝试中转 IP
    const attempts = [
      { name: '直连', ip: null },
      ...CF_FALLBACK_IPS.map(ip => ({ name: `中转 IP ${ip}`, ip }))
    ];

    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      
      try {
        console.log(`[${i + 1}/${attempts.length}] 连接到目标: ${host}:${port} - ${attempt.name}`);

        // 建立 TCP 连接
        remoteSocket = await tryConnect(host, port, attempt.ip);
        
        console.log(`TCP 连接已建立 (${attempt.name})`);

        // 获取 Writer 和 Reader
        remoteWriter = remoteSocket.writable.getWriter();
        remoteReader = remoteSocket.readable.getReader();

        // 发送第一帧数据
        if (firstFrameData && firstFrameData.length > 0) {
          try {
            const bytes = stringToBytes(firstFrameData);
            await remoteWriter.write(bytes);
            console.log(`已发送第一帧数据，长度: ${bytes.length}`);
          } catch (err) {
            console.error('发送第一帧数据失败:', err.message);
            
            // 如果是 CF 限制错误且还有重试机会，继续尝试
            if (isCloudflareLimitError(err) && i < attempts.length - 1) {
              console.log('检测到 Cloudflare 限制，准备使用中转 IP 重试...');
              
              // 清理当前连接
              try { remoteWriter.releaseLock(); } catch (e) {}
              try { remoteReader.releaseLock(); } catch (e) {}
              try { remoteSocket.close(); } catch (e) {}
              remoteWriter = null;
              remoteReader = null;
              remoteSocket = null;
              
              lastError = err;
              continue; // 继续下一次尝试
            }
            
            throw err;
          }
        }

        // 连接成功
        sendWebSocketMessage(webSocket, 'CONNECTED');
        console.log(`已发送 CONNECTED 消息 (通过 ${attempt.name})`);

        // 开始数据转发
        pumpRemoteToWebSocket().catch(err => {
          if (!isClosed) {
            console.error('数据转发异常:', err);
            cleanup();
          }
        });

        return; // 成功，退出函数

      } catch (err) {
        console.error(`连接失败 (${attempt.name}):`, err.message);
        lastError = err;
        
        // 清理失败的连接
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

        // 如果是 CF 限制错误且还有重试机会，继续尝试
        if (isCloudflareLimitError(err) && i < attempts.length - 1) {
          console.log(`检测到 Cloudflare 限制，将尝试下一个中转 IP (${i + 2}/${attempts.length})...`);
          continue;
        }
        
        // 如果不是 CF 错误，或者已经是最后一次尝试，抛出错误
        if (i === attempts.length - 1) {
          throw lastError;
        }
      }
    }

    // 所有尝试都失败
    throw lastError || new Error('所有连接尝试均失败');
  };

  // 监听 WebSocket 消息
  webSocket.addEventListener('message', async (event) => {
    if (isClosed) return;

    try {
      const data = event.data;

      if (typeof data === 'string') {
        if (data.startsWith('CONNECT:')) {
          const content = data.substring(8);
          const separatorIndex = content.indexOf('|');

          if (separatorIndex === -1) {
            sendWebSocketMessage(webSocket, 'ERROR:无效的 CONNECT 消息格式');
            return;
          }

          const targetAddr = content.substring(0, separatorIndex);
          const firstFrameData = content.substring(separatorIndex + 1);

          console.log(`收到 CONNECT 请求: ${targetAddr}, 首帧长度: ${firstFrameData.length}`);

          try {
            await connectToRemote(targetAddr, firstFrameData);
          } catch (err) {
            console.error('连接目标失败:', err.message);
            sendWebSocketMessage(webSocket, 'ERROR:连接目标失败: ' + err.message);
            cleanup();
          }
        }
        else if (data.startsWith('DATA:')) {
          if (remoteWriter) {
            try {
              const payload = data.substring(5);
              const bytes = stringToBytes(payload);
              await remoteWriter.write(bytes);
            } catch (err) {
              console.error('写入远程数据失败:', err.message);
              cleanup();
            }
          } else {
            console.warn('收到数据但远程连接未建立');
          }
        }
        else if (data === 'CLOSE') {
          console.log('收到客户端关闭请求');
          cleanup();
        }
        else {
          console.warn('未知的文本消息:', data.substring(0, 50));
        }
      }
      else if (data instanceof ArrayBuffer) {
        if (remoteWriter) {
          try {
            await remoteWriter.write(new Uint8Array(data));
          } catch (err) {
            console.error('写入二进制数据失败:', err.message);
            cleanup();
          }
        } else {
          console.warn('收到二进制数据但远程连接未建立');
        }
      }

    } catch (err) {
      console.error('处理消息失败:', err.message, err.stack);
      cleanup();
    }
  });

  webSocket.addEventListener('close', (event) => {
    console.log(`WebSocket 关闭: code=${event.code}, reason=${event.reason || '无'}`);
    cleanup();
  });

  webSocket.addEventListener('error', (event) => {
    console.error('WebSocket 错误:', event);
    cleanup();
  });
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
    if (ws.readyState === WS_READY_STATE_OPEN || 
        ws.readyState === WS_READY_STATE_CLOSING) {
      ws.close(1000, 'Server closed');
    }
  } catch (err) {}
}
