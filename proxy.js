/**
 * Cloudflare Worker — 通用请求代理 (Request Proxy)
 *
 * 用法：
 *   将 TARGET_BASE 配置改为你想要代理的目标地址（不含末尾斜杠）。
 *   部署后，访问 https://<your-worker>.workers.dev/<path>
 *   请求会被转发到 TARGET_BASE/<path>，并原样返回响应。
 *
 *   也可以通过 Header "x-proxy-target"（目标 base）或 URL 参数 "target"（完整目标链接）
 *   动态指定目标地址，例如：
 *     curl -H "x-proxy-target: https://api.example.com" https://<worker>.workers.dev/users
 *     curl "https://<worker>.workers.dev/?target=https://api.example.com/users?page=1"
 *
 * WebSocket 分发端点：
 *   连接 wss://<worker>.workers.dev/ws?topics=system,user 即可订阅一个或多个 topic。
 *   客户端发送 JSON 消息 { "topic": "system", "data": ... }，
 *   该消息会被分发给所有订阅了 "system" 的连接（默认不回发给发送者，可用 echo 控制）。
 */

// ====== 配置 ======
const TARGET_BASE = "https://api.example.com"; // 默认代理目标（不含末尾斜杠）
const PROXY_PREFIX = "/proxy";
const ALLOW_DYNAMIC_TARGET = true; // 是否允许通过 Header 动态指定目标
// ==================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // WebSocket 分发端点：/ws?topics=system,user
    if (url.pathname === "/ws") {
      return handleWebSocket(request, env);
    }

    if(url.pathname.startsWith(PROXY_PREFIX)) {
      return await handleProxy(request, env, ctx);
    }

    return new Response("", {
      status: 404,
    });
  },
};

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

  try {
    const url = new URL(request.url);
    const targetParam = url.searchParams.get("target");
    const headerTarget = request.headers.get("x-proxy-target");

    let targetUrl;
    if (ALLOW_DYNAMIC_TARGET && targetParam) {
      // URL 参数 target 为完整目标链接，直接使用
      targetUrl = targetParam;
    } else {
      // 确定目标 base（Header 指定的是 base）
      let targetBase = TARGET_BASE.replace(/\/+$/, "");
      if (ALLOW_DYNAMIC_TARGET && headerTarget) {
        targetBase = headerTarget.replace(/\/+$/, "");
      }

      // 从转发查询参数中移除代理专用的 target，避免泄露给目标服务
      const forwardParams = new URLSearchParams(url.searchParams);
      forwardParams.delete("target");
      const forwardSearch = forwardParams.toString();

      // 拼接目标 URL：保留原始路径和查询参数
      targetUrl = targetBase + url.pathname.substring(PROXY_PREFIX.length) + (forwardSearch ? "?" + forwardSearch : "");
    }

    // 构造转发请求的 headers，去掉 hop-by-hop 和代理专用头
    const proxyHeaders = new Headers(request.headers);
    ["host", "x-proxy-target", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cdn-loop"].forEach((h) => {
      proxyHeaders.delete(h);
    });

    // 构造转发请求
    const init = {
      method: request.method,
      headers: proxyHeaders,
      redirect: "follow",
      timeout: 30000,
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
    return withCORS(response);
  } catch (err) {
    // fetch 抛出异常时，若异常本身携带响应，则原样返回该响应
    if (err && err.response instanceof Response) {
      return withCORS(err.response);
    }
    return new Response(JSON.stringify({ error: err.message }), {
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

function withCORS(response) {
  const respHeaders = new Headers(response.headers);
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
  respHeaders.set("Access-Control-Allow-Headers", "*");

  // 无响应体的状态码（204/304 等）必须传 null
  const noBody = [101, 204, 205, 304].includes(response.status);
  return new Response(noBody ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: respHeaders,
  });
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
