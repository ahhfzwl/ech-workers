const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
// 🚀 优化点 1: 允许回退 IP 包含端口
const CF_FALLBACK_IPS = ['210.61.97.241:81']; 

// 复用 TextEncoder，避免重复创建
const encoder = new TextEncoder();

import { connect } from 'cloudflare:sockets';

export default {
    async fetch(request, env, ctx) {
        try {
            const token = '';
            const upgradeHeader = request.headers.get('Upgrade');
            
            if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
                return new URL(request.url).pathname === '/' 
                  ? new Response('WebSocket Proxy Server', { status: 200 })
                  : new Response('Expected WebSocket', { status: 426 });
            }

            if (token && request.headers.get('Sec-WebSocket-Protocol') !== token) {
                return new Response('Unauthorized', { status: 401 });
            }

            const [client, server] = Object.values(new WebSocketPair());
            server.accept();
            
            handleSession(server).catch(() => safeCloseWebSocket(server));

            const responseInit = {
                status: 101,
                webSocket: client
            };
            
            if (token) {
                responseInit.headers = { 'Sec-WebSocket-Protocol': token };
            }

            return new Response(null, responseInit);
            
        } catch (err) {
            return new Response(err.toString(), { status: 500 });
        }
    },
};

async function handleSession(webSocket) {
    let remoteSocket, remoteWriter, remoteReader;
    let isClosed = false;

    const cleanup = () => {
        if (isClosed) return;
        isClosed = true;
        
        try { remoteWriter?.releaseLock(); } catch {}
        try { remoteReader?.releaseLock(); } catch {}
        try { remoteSocket?.close(); } catch {}
        
        remoteWriter = remoteReader = remoteSocket = null;
        safeCloseWebSocket(webSocket);
    };

    const pumpRemoteToWebSocket = async () => {
        try {
            while (!isClosed && remoteReader) {
                const { done, value } = await remoteReader.read();
                
                if (done) break;
                if (webSocket.readyState !== WS_READY_STATE_OPEN) break;
                if (value?.byteLength > 0) webSocket.send(value);
            }
        } catch {}
        
        if (!isClosed) {
            try { webSocket.send('CLOSE'); } catch {}
            cleanup();
        }
    };

    const parseAddress = (addr) => {
        // 兼容 IPv6 [host]:port 格式
        if (addr[0] === '[') {
            const end = addr.indexOf(']');
            return {
                host: addr.substring(1, end),
                port: parseInt(addr.substring(end + 2), 10)
            };
        }
        // 处理 IPv4 host:port 格式
        const sep = addr.lastIndexOf(':');
        // 确保找到了端口分隔符
        if (sep === -1 || sep === addr.length - 1) {
            // 如果没有找到端口，或者端口为空，返回默认 443 或 80，这里暂时不设置默认端口，只返回解析到的部分
            // 实际上对于 CF_FALLBACK_IPS 应该强制要求带端口，但为了健壮性，这里让 host 为完整地址
             return {
                host: addr,
                port: 443 // 假设默认端口，或者根据实际情况处理
            };
        }
        return {
            host: addr.substring(0, sep),
            port: parseInt(addr.substring(sep + 1), 10)
        };
    };

    const isCFError = (err) => {
        const msg = err?.message?.toLowerCase() || '';
        return msg.includes('proxy request') || 
                   msg.includes('cannot connect') || 
                   msg.includes('cloudflare');
    };

    const connectToRemote = async (targetAddr, firstFrameData) => {
        const { host: targetHost, port: targetPort } = parseAddress(targetAddr);
        // 🚀 优化点 2: 回退尝试的地址现在是包含端口的完整地址字符串
        const attempts = [null, ...CF_FALLBACK_IPS];

        for (let i = 0; i < attempts.length; i++) {
            let connHost = targetHost;
            let connPort = targetPort;
            let useFallback = false;

            if (i > 0 && attempts[i]) {
                // 使用回退 IP 时，解析其 host 和 port
                const { host: fallbackHost, port: fallbackPort } = parseAddress(attempts[i]);
                connHost = fallbackHost;
                connPort = fallbackPort;
                useFallback = true;
            }
            
            // 如果回退 IP 没有端口，则使用目标地址的端口
            if (useFallback && !connPort) {
                connPort = targetPort;
            } else if (!connPort) {
                // 如果目标地址都没有端口，连接失败（实际场景中 targetAddr 应该包含端口）
                throw new Error('Target address must include port.');
            }

            try {
                remoteSocket = connect({
                    hostname: connHost, // 使用解析出的 host
                    port: connPort      // 使用解析出的 port
                });

                if (remoteSocket.opened) await remoteSocket.opened;

                remoteWriter = remoteSocket.writable.getWriter();
                remoteReader = remoteSocket.readable.getReader();

                // 发送首帧数据
                if (firstFrameData) {
                    await remoteWriter.write(encoder.encode(firstFrameData));
                }

                webSocket.send('CONNECTED');
                pumpRemoteToWebSocket();
                return;

            } catch (err) {
                // 清理失败的连接
                try { remoteWriter?.releaseLock(); } catch {}
                try { remoteReader?.releaseLock(); } catch {}
                try { remoteSocket?.close(); } catch {}
                remoteWriter = remoteReader = remoteSocket = null;

                // 如果不是 CF 错误或已是最后尝试，抛出错误
                if (!isCFError(err) || i === attempts.length - 1) {
                    throw err;
                }
            }
        }
    };

    webSocket.addEventListener('message', async (event) => {
        if (isClosed) return;

        try {
            const data = event.data;

            if (typeof data === 'string') {
                if (data.startsWith('CONNECT:')) {
                    const sep = data.indexOf('|', 8);
                    // CONNECT:host:port|...
                    await connectToRemote(
                        data.substring(8, sep),
                        data.substring(sep + 1)
                    );
                }
                else if (data.startsWith('DATA:')) {
                    if (remoteWriter) {
                        await remoteWriter.write(encoder.encode(data.substring(5)));
                    }
                }
                else if (data === 'CLOSE') {
                    cleanup();
                }
            }
            else if (data instanceof ArrayBuffer && remoteWriter) {
                await remoteWriter.write(new Uint8Array(data));
            }
        } catch (err) {
            try { webSocket.send('ERROR:' + err.message); } catch {}
            cleanup();
        }
    });

    webSocket.addEventListener('close', cleanup);
    webSocket.addEventListener('error', cleanup);
}

function safeCloseWebSocket(ws) {
    try {
        if (ws.readyState === WS_READY_STATE_OPEN || 
            ws.readyState === WS_READY_STATE_CLOSING) {
            ws.close(1000, 'Server closed');
        }
    } catch {}
}
