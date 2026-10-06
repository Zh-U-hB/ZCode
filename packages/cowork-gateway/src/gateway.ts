import http from "node:http";
import https from "node:https";
import { readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { GatewayConfig } from "./config.js";
import { createLogger } from "./log.js";
import { SessionManager, parseCookies, sessionCookieName } from "./auth.js";
import { UserStore } from "./users.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";
import {
  UserServerManager,
  type UserServerRecord,
} from "./user-server-manager.js";
import type { InviteCodeStore } from "./invite-code.js";
import { proxyHttpRequest, proxyWebSocketUpgrade } from "./proxy.js";
import { renderLoginPage } from "./login-page.js";

const log = createLogger("gateway");

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

interface AuthedRequestContext {
  userId: string;
  username: string;
}

function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...securityHeaders(),
    ...extraHeaders,
  });
  res.end(payload);
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

async function readBodyJson(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) {
      exceeded = true;
      if (total > 8 * 1024 * 1024) {
        // 恶意超大 body：继续消费只为保住 keep-alive 连接的正确性，
        // 超过硬上限直接断连，由客户端承受后果。
        req.destroy();
        break;
      }
      continue;
    }
    chunks.push(buffer);
  }
  if (exceeded) {
    // body 必须消费完整再响应，否则 Node 会销毁未读完的 keep-alive socket，
    // 客户端连接池复用死连接时表现为下个请求 ECONNRESET。
    return { ok: false, error: "请求体过大" };
  }
  if (chunks.length === 0) {
    return { ok: true, value: {} };
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, error: "请求体不是合法 JSON" };
  }
}

function clientIp(req: http.IncomingMessage): string {
  // 网关仅监听回环；x-forwarded-for 不可信，仅作诊断参考。
  return req.socket.remoteAddress ?? "unknown";
}

/** 浏览器跨站防护：带 Origin 的写请求与 WS 升级必须同源。 */
function isSameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers["origin"];
  if (!origin) return true;
  if (Array.isArray(origin)) return false;
  const host = req.headers["host"];
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export interface GatewayDependencies {
  config: GatewayConfig;
  users: UserStore;
  sessions: SessionManager;
  manager: UserServerManager;
  inviteCodes: InviteCodeStore;
}

export function createGateway(deps: GatewayDependencies): http.Server {
  const { config, users, sessions, manager, inviteCodes } = deps;
  const loginIpLimiter = new SlidingWindowRateLimiter(15 * 60_000, 20);
  const loginNameLimiter = new SlidingWindowRateLimiter(15 * 60_000, 8);
  const registerIpLimiter = new SlidingWindowRateLimiter(60 * 60_000, 10);

  const resolveSession = (req: http.IncomingMessage): AuthedRequestContext | null => {
    const cookies = parseCookies(req.headers["cookie"]);
    const payload = sessions.verifyToken(cookies.get(sessionCookieName));
    if (!payload) return null;
    // 用户被删除后立即失效。
    if (!users.findById(payload.sub)) return null;
    return { userId: payload.sub, username: payload.username };
  };

  const handleAuthRoute = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> => {
    if (pathname === "/login") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "方法不允许" });
        return true;
      }
      if (resolveSession(req)) {
        res.writeHead(302, { Location: "/" });
        res.end();
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(renderLoginPage());
      return true;
    }

    if (!pathname.startsWith("/auth/")) {
      return false;
    }

    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: "跨站请求被拒绝" });
      return true;
    }

    if (pathname === "/auth/state" && req.method === "GET") {
      const session = resolveSession(req);
      sendJson(res, 200, {
        authenticated: Boolean(session),
        ...(session ? { username: session.username } : {}),
      });
      return true;
    }

    if (pathname === "/auth/logout" && req.method === "POST") {
      sendJson(res, 200, { ok: true }, { "Set-Cookie": sessions.clearCookie() });
      return true;
    }

    if ((pathname === "/auth/login" || pathname === "/auth/register") && req.method === "POST") {
      const ip = clientIp(req);
      const isRegister = pathname === "/auth/register";
      const limiter = isRegister ? registerIpLimiter : loginIpLimiter;
      if (!limiter.hit(`ip:${ip}`)) {
        sendJson(res, 429, { error: "请求过于频繁，请稍后再试" });
        return true;
      }

      const body = await readBodyJson(req, config.maxAuthBodyBytes);
      if (!body.ok) {
        sendJson(res, 400, { error: body.error });
        return true;
      }
      const input = body.value as {
        username?: unknown;
        password?: unknown;
        displayName?: unknown;
        inviteCode?: unknown;
      };
      const username = typeof input.username === "string" ? input.username.trim() : "";
      const password = typeof input.password === "string" ? input.password : "";
      const displayName = typeof input.displayName === "string" ? input.displayName : undefined;
      const inviteCode = typeof input.inviteCode === "string" ? input.inviteCode.trim() : "";

      if (isRegister) {
        // 邀请码门槛：唯一码，恒定时间校验；错误消息不区分格式错与码错。
        if (!inviteCodes.verify(inviteCode)) {
          sendJson(res, 403, { error: "邀请码无效，无法注册" });
          return true;
        }
        if (users.countUsers() >= config.maxUsers) {
          sendJson(res, 403, { error: "平台用户数已达上限" });
          return true;
        }
        const created = await users.createUser({ username, password, displayName });
        if (!created.ok) {
          sendJson(res, 400, { error: created.error });
          return true;
        }
        const token = sessions.issueToken({
          id: created.user.id,
          username: created.user.username,
        });
        log.info("用户注册", { username: created.user.username });
        sendJson(
          res,
          200,
          { ok: true, user: created.user },
          { "Set-Cookie": sessions.sessionCookie(token) },
        );
        return true;
      }

      if (!loginNameLimiter.hit(`name:${username.toLowerCase()}`)) {
        sendJson(res, 429, { error: "该账户尝试过于频繁，请 15 分钟后再试" });
        return true;
      }
      const user = await users.verifyCredentials(username, password);
      if (!user) {
        sendJson(res, 401, { error: "用户名或密码错误" });
        return true;
      }
      const token = sessions.issueToken({ id: user.id, username: user.username });
      log.info("用户登录", { username: user.username });
      sendJson(res, 200, { ok: true, user }, { "Set-Cookie": sessions.sessionCookie(token) });
      return true;
    }

    sendJson(res, 404, { error: "未知的认证路由" });
    return true;
  };

  const handleGatewayApi = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    session: AuthedRequestContext,
  ): Promise<boolean> => {
    if (pathname !== "/api/gateway/me" || req.method !== "GET") {
      return false;
    }
    const record = users.findById(session.userId);
    if (!record) {
      sendJson(res, 401, { error: "登录态已失效" }, { "Set-Cookie": sessions.clearCookie() });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      user: {
        id: record.id,
        username: record.username,
        displayName: record.displayName,
        createdAt: record.createdAt,
      },
      server: manager.describe(session.userId),
    });
    return true;
  };

  /** OAuth token 交换透传：保持 Web 端登录模型账号能力。 */
  const proxyOauthToken = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const target = new URL(req.url ?? "/", config.endpointOrigin);
    const headers = { ...req.headers };
    delete headers["connection"];
    delete headers["host"];
    headers["host"] = target.host;
    const proxyReq = https.request(
      {
        hostname: target.hostname,
        port: target.port ? Number(target.port) : 443,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      },
    );
    proxyReq.once("error", (error) => {
      log.warn("oauth token 透传失败", { message: error.message });
      if (!res.headersSent) {
        sendJson(res, 502, { error: "上游服务不可用" });
      } else {
        res.end();
      }
    });
    req.pipe(proxyReq, { end: true });
  };

  const serveStatic = async (
    res: http.ServerResponse,
    pathname: string,
  ): Promise<void> => {
    const root = resolve(config.webDist);
    const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    let candidate = resolve(root, relativePath);
    if (!isInsideDirectory(root, candidate)) {
      sendJson(res, 404, { error: "Not Found" });
      return;
    }
    try {
      const candidateStat = await stat(candidate);
      if (candidateStat.isDirectory()) {
        candidate = join(candidate, "index.html");
      }
      const content = await readFile(candidate);
      res.writeHead(200, {
        "Content-Type": mimeTypes[extname(candidate).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": candidate.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
      });
      res.end(content);
    } catch {
      // SPA fallback：非 API 路径回退 index.html。
      if (!pathname.startsWith("/api/") && !pathname.startsWith("/ws")) {
        try {
          const index = await readFile(join(root, "index.html"));
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
          });
          res.end(index);
          return;
        } catch {
          // 继续走 404。
        }
      }
      sendJson(res, 404, { error: "Not Found" });
    }
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      try {
        if (await handleAuthRoute(req, res, pathname)) {
          return;
        }

        // 登录门：页面与 API 均要求会话。
        const session = resolveSession(req);

        if (pathname === "/api/v1/oauth/token") {
          if (!session) {
            sendJson(res, 401, { error: "未登录" });
            return;
          }
          proxyOauthToken(req, res);
          return;
        }

        if (pathname.startsWith("/api/gateway/")) {
          if (!session) {
            sendJson(res, 401, { error: "未登录" });
            return;
          }
          if (await handleGatewayApi(req, res, pathname, session)) {
            return;
          }
          sendJson(res, 404, { error: "未知的网关路由" });
          return;
        }

        if (pathname.startsWith("/api/") || pathname.startsWith("/ws")) {
          if (!session) {
            sendJson(res, 401, { error: "未登录" });
            return;
          }
          const acquired = await manager.acquire(session.userId, session.username);
          if (!acquired.ok) {
            sendJson(res, 503, { error: acquired.error });
            return;
          }
          const record = acquired.record;
          manager.beginConnection(record);
          res.once("close", () => manager.endConnection(record));
          proxyHttpRequest(req, res, record);
          return;
        }

        // 静态资源与页面。
        if (!session) {
          res.writeHead(302, {
            Location: "/login",
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }
        await serveStatic(res, pathname);
      } catch (error) {
        log.error("请求处理异常", {
          pathname,
          message: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          sendJson(res, 500, { error: "网关内部错误" });
        } else {
          res.end();
        }
      }
    })();
  });

  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (!pathname.startsWith("/ws")) {
        socket.destroy();
        return;
      }
      if (!isSameOrigin(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      const session = resolveSession(req);
      if (!session) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const acquired = await manager.acquire(session.userId, session.username);
      if (!acquired.ok) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      const record = acquired.record;
      manager.beginConnection(record);
      socket.once("close", () => manager.endConnection(record));
      socket.once("error", () => manager.endConnection(record));
      proxyWebSocketUpgrade(req, socket, head, record);
    })();
  });

  return server;
}
