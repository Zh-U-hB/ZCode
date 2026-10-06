import http from "node:http";
import type { Duplex } from "node:stream";
import type { UserServerRecord } from "./user-server-manager.js";

/** 将 token 附加到转发 path 的 query 上，供 user-server 的既有 token 校验使用。 */
function pathWithToken(url: string, token: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

/**
 * HTTP 反向代理：原样转发 method/headers/body。
 * 请求与响应均为流式透传，不在网关缓冲大 body。
 */
export function proxyHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  record: UserServerRecord,
): void {
  const targetPath = pathWithToken(req.url ?? "/", record.accessToken);
  const headers = { ...req.headers };
  delete headers["connection"];
  delete headers["upgrade"];
  headers["host"] = `127.0.0.1:${record.port}`;

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: record.port,
      method: req.method,
      path: targetPath,
      headers,
    },
    (proxyRes) => {
      const responseHeaders = { ...proxyRes.headers };
      // 透传 user-server 的 token cookie 会破坏会话边界，剥离 set-cookie 中的 token 写入。
      if (Array.isArray(responseHeaders["set-cookie"])) {
        responseHeaders["set-cookie"] = responseHeaders["set-cookie"].filter(
          (cookie) => !cookie.startsWith("zcode_lite_token="),
        );
        if (responseHeaders["set-cookie"].length === 0) {
          delete responseHeaders["set-cookie"];
        }
      }
      res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
      proxyRes.pipe(res, { end: true });
    },
  );

  proxyReq.once("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end(
      JSON.stringify({ error: `用户服务不可用：${error instanceof Error ? error.message : String(error)}` }),
    );
  });
  req.pipe(proxyReq, { end: true });
}

/**
 * WebSocket（HTTP Upgrade）反向代理：以子进程 upgrade 通道桥接后双向 pipe。
 * WS 帧为二进制流，TCP 级透传即协议透明。
 */
export function proxyWebSocketUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  record: UserServerRecord,
): void {
  const targetPath = pathWithToken(req.url ?? "/ws", record.accessToken);
  const headers = { ...req.headers };
  delete headers["connection"];
  delete headers["upgrade"];
  headers["host"] = `127.0.0.1:${record.port}`;
  headers["connection"] = "Upgrade";
  headers["upgrade"] = "websocket";

  const proxyReq = http.request({
    hostname: "127.0.0.1",
    port: record.port,
    method: "GET",
    path: targetPath,
    headers,
  });

  const cleanup = () => {
    socket.destroy();
    proxyReq.destroy();
  };
  socket.once("error", cleanup);
  proxyReq.once("error", cleanup);

  proxyReq.once("upgrade", (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n` +
        Object.entries(proxyRes.headers)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (proxyHead.length > 0) {
      socket.write(proxyHead);
    }
    proxySocket.pipe(socket).pipe(proxySocket);
    proxySocket.once("error", () => cleanup());
    socket.once("close", () => proxySocket.destroy());
    proxySocket.once("close", () => socket.destroy());
  });

  // 非 upgrade 响应（如 401）也需回传给客户端，否则挂起到超时。
  proxyReq.once("response", (proxyRes) => {
    let body = "";
    proxyRes.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    proxyRes.on("end", () => {
      socket.end(
        `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n` +
          `content-type: ${proxyRes.headers["content-type"] ?? "text/plain"}\r\n` +
          `content-length: ${Buffer.byteLength(body)}\r\n` +
          `connection: close\r\n\r\n${body}`,
      );
    });
  });

  if (head.length > 0) {
    proxyReq.write(head);
  }
  proxyReq.end();
}
