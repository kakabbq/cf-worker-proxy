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
 */

// ====== 配置 ======
const TARGET_BASE = "https://api.example.com"; // 默认代理目标（不含末尾斜杠）
const ALLOW_DYNAMIC_TARGET = true; // 是否允许通过 Header 动态指定目标
// ==================

export default {
  async fetch(request, env, ctx) {
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
        targetUrl = targetBase + url.pathname + (forwardSearch ? "?" + forwardSearch : "");
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

      // 构造返回响应，添加 CORS 头
      const respHeaders = new Headers(response.headers);
      respHeaders.set("Access-Control-Allow-Origin", "*");
      respHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
      respHeaders.set("Access-Control-Allow-Headers", "*");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};

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
