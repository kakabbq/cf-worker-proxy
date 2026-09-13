/**
 * Cloudflare Worker — 通用请求代理 (Request Proxy)
 *
 * 用法：
 *   所有请求会被转发到 Cloudflare Workers VPC 中的 home-mac 服务
 *   （绑定名 HOME_MAC，见 wrangler.toml 的 vpc_services）。
 *   部署后，访问 https://<your-worker>.workers.dev/<path>
 *   请求会被转发到 home-mac 服务的 <path>，并原样返回响应。
 *
 * WebSocket 分发端点：
 *   连接 wss://<worker>.workers.dev/worker-ws?topics=system,user 即可订阅一个或多个 topic。
 *   客户端发送 JSON 消息 { "topic": "system", "data": ... }，
 *   该消息会被分发给所有订阅了 "system" 的连接（默认不回发给发送者，可用 echo 控制）。
 *
 * 单请求代理 转发端点：
 *   连接 https://<worker>.workers.dev/proxy?target=https://www.xx.com?aa=1。
 *
 * 站点代理 转发端点：
 *   连接 https://<worker>.workers.dev/a/b => `${env.PROXY_ORIGIN}/a/b`
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // WebSocket 分发端点：/worker-ws?topics=system,user
    if (url.pathname === "/worker-ws") {
      return handleWebSocket(request, env);
    }


    if (url.pathname === "/proxy") {
      return await handleProxyUrl(request, env, ctx);
    }

    if(env.PROXY_ORIGIN) {
        return await handleProxy(request, env, ctx);
    }

    return new Response("", {
      status: 404,
    });
  },
};

async function handleProxyWebSocket(request, env, ctx) {
  const url = new URL(request.url);

  // 1. 只处理目标路径的 WebSocket 升级请求
  if (url.pathname !== '/somewhere1' || request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Not Found', {status: 404});
  }

  // 2. 创建 WebSocket 对，获取客户端和服务器端
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  // 3. 作为客户端连接到远程 WebSocket 服务器
  // 注意：Cloudflare Worker 的环境支持 new WebSocket(url) [citation:1]
  const remoteUrl = 'ws://somedomain/somewhere2';
  const remote = new WebSocket(remoteUrl);
  remote.accept();

  // 4. 双向管道转发消息
  // 客户端 -> 远程
  server.addEventListener('message', (event) => {
    if (remote.readyState === WebSocket.OPEN) {
      remote.send(event.data);
    }
  });

  // 远程 -> 客户端
  remote.addEventListener('message', (event) => {
    if (server.readyState === WebSocket.OPEN) {
      server.send(event.data);
    }
  });

  // 5. 处理连接关闭
  server.addEventListener('close', () => remote.close());
  remote.addEventListener('close', () => server.close());

  // 6. 返回 101 Switching Protocols 响应，将客户端 WebSocket 交还给请求者
  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

async function handleProxyUrl(request, env, ctx) {
  // 只允许 GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS
  const allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  if (!allowedMethods.includes(request.method)) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // CORS 预检
  if (request.method === "OPTIONS") {
    return handleCORS();
  }

  const url = new URL(request.url);
  try {
    const targetUrl = url.searchParams.get("target");
    // 构造转发请求的 headers，去掉 hop-by-hop 和代理专用头
    const proxyHeaders = new Headers(request.headers);
    ["host", "x-proxy-target", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cdn-loop"].forEach((h) => {
      proxyHeaders.delete(h);
    });

    // 构造转发请求
    const init = {
      method: request.method,
      headers: proxyHeaders,
      redirect: "manual",
    };

    // 对有 body 的方法，透传请求体
    if (["POST", "PUT", "PATCH"].includes(request.method)) {
      init.body = request.body;
      // 保留原始 Content-Type
      const ct = request.headers.get("Content-Type");
      if (ct) init.headers.set("Content-Type", ct);
    }
    // 发起代理请求
    const response = await fetch(targetUrl, init);

    // 原样透传目标响应（包括 400 / 502 等错误状态），仅在返回头追加 CORS
    return withCORS(response, url, env);
  } catch (err) {
    // fetch 抛出异常时，若异常本身携带响应，则原样返回该响应
    if (err && err.response instanceof Response) {
      return withCORS(err.response, url, env);
    }
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}


async function handleProxy(request, env, ctx) {
  // 只允许 GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS
  const allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  if (!allowedMethods.includes(request.method)) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // CORS 预检
  if (request.method === "OPTIONS") {
    return handleCORS();
  }

  if (request.headers.get('Upgrade') === 'websocket') {
    return handleProxyWebSocket(request, env, ctx);
  }

  const url = new URL(request.url);
  try {
    // 从转发查询参数中移除代理专用的 target，避免泄露给目标服务
    const forwardParams = new URLSearchParams(url.searchParams);
    forwardParams.delete("target");
    const forwardSearch = forwardParams.toString();

    // 目标 URL：host 仅用于 Host 头 / SNI，路径与查询保留原样
    const targetUrl = `${env.PROXY_ORIGIN}${url.pathname}${forwardSearch ? "?" + forwardSearch : ""}`;
    // 构造转发请求的 headers，去掉 hop-by-hop 和代理专用头
    const proxyHeaders = new Headers(request.headers);
    ["host", "x-proxy-target", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cdn-loop"].forEach((h) => {
      proxyHeaders.delete(h);
    });

    // 构造转发请求
    const init = {
      method: request.method,
      headers: proxyHeaders,
      redirect: "manual",
    };

    // 对有 body 的方法，透传请求体
    if (["POST", "PUT", "PATCH"].includes(request.method)) {
      init.body = request.body;
      // 保留原始 Content-Type
      const ct = request.headers.get("Content-Type");
      if (ct) init.headers.set("Content-Type", ct);
    }

    let response = null;
    if(env.PROXY_VPC){
      const binding = env[env.PROXY_VPC];
      if (!binding) {
        return new Response(`VPC binding ${env.PROXY_VPC} 未配置（见 wrangler.toml 的 vpc_services）`, { status: 501 });
      }
      // 通过 VPC Service 绑定发起代理请求（不能使用全局 fetch）
      response = await binding.fetch(targetUrl, init);
    }else{
      response = fetch(targetUrl, init);
    }

    // 原样透传目标响应（包括 400 / 502 等错误状态），仅在返回头追加 CORS
    return withCORS(response, url, env);
  } catch (err) {
    // fetch 抛出异常时，若异常本身携带响应，则原样返回该响应
    if (err && err.response instanceof Response) {
      return withCORS(err.response, new URL(request.url), env);
    }

    return new Response(err.message, {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}
/**
 * 将 WebSocket 升级请求转发到全局 Durable Object 完成订阅与分发。
 */
function handleWebSocket(request, env) {
  const upgrade = request.headers.get("Upgrade");
  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }
  if (!env.WS_HUB) {
    return new Response("WebSocket hub 未配置（缺少 WS_HUB Durable Object 绑定）", { status: 501 });
  }

  // 所有连接共用一个 Hub，便于对同一 topic 的连接做全局分发
  const id = env.WS_HUB.idFromName("global");
  return env.WS_HUB.get(id).fetch(request);
}

/**
 * 全局 WebSocket Hub：维护 topic -> 连接集合，并把发布的消息分发给同 topic 的订阅者。
 * 使用 Durable Object 的 WebSocket Hibernation，空闲时不会持续计费。
 */
export class WebSocketHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.topics = new Map();
    // DO 从休眠中恢复时内存 Map 会丢失，需根据已接受的连接重建订阅关系
    this.rebuild();
  }

  rebuild() {
    this.topics = new Map();
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() || {};
      for (const topic of attachment.topics || []) {
        this.subscribe(topic, ws);
      }
    }
  }

  subscribe(topic, ws) {
    let subscribers = this.topics.get(topic);
    if (!subscribers) {
      subscribers = new Set();
      this.topics.set(topic, subscribers);
    }
    subscribers.add(ws);
  }

  unsubscribe(ws) {
    for (const [topic, subscribers] of this.topics) {
      subscribers.delete(ws);
      if (subscribers.size === 0) this.topics.delete(topic);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const topics = (url.searchParams.get("topics") || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    server.serializeAttachment({ topics });
    for (const topic of topics) {
      this.subscribe(topic, server);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    const topic = msg.topic || msg.channel;
    if (!topic) return;

    const subscribers = this.topics.get(topic);
    if (!subscribers || subscribers.size === 0) return;

    const payload = JSON.stringify({
      topic,
      data: msg.data !== undefined ? msg.data : msg.payload,
      ts: Date.now(),
    });

    const echo = msg.echo === true;
    for (const subscriber of subscribers) {
      if (subscriber === ws && !echo) continue;
      try {
        subscriber.send(payload);
      } catch {
        this.unsubscribe(subscriber);
      }
    }
  }

  webSocketClose(ws) {
    this.unsubscribe(ws);
  }

  webSocketError(ws) {
    this.unsubscribe(ws);
  }
}

function withCORS(response, workerUrl, env) {
  const respHeaders = new Headers(response.headers);
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
  respHeaders.set("Access-Control-Allow-Headers", "*");

  if(env.FORCE_REWRITE){
    rewriteLocation(respHeaders, workerUrl);
  }

  // 无响应体的状态码（204/304 等）必须传 null
  const noBody = [101, 204, 205, 304].includes(response.status);
  return new Response(noBody ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: respHeaders,
  });
}

/**
 * 若响应 Location 指向 TARGET_HOST，则把其 host 换成 worker 自身的 host，
 * 避免客户端被重定向到无法访问的内网主机。
 */
function rewriteLocation(headers, workerUrl) {
  const location = headers.get("Location");
  if (!location || !workerUrl) return;

  try {
    const loc = new URL(location, workerUrl);
    if (loc.hostname !== TARGET_HOST) return;
    loc.host = workerUrl.host;
    headers.set("Location", loc.toString());
  } catch {
    // Location 非法时保持原样
  }
}

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}
