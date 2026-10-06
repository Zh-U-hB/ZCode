import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GatewayConfig } from "./config.js";

export const sessionCookieName = "cowork_session";

interface JwtPayload {
  sub: string;
  username: string;
  iat: number;
  exp: number;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
}

/** 会话签名密钥：首次生成后落盘复用；轮换即全员登出。 */
export class JwtSecret {
  private key: Buffer;

  constructor(dataRoot: string) {
    mkdirSync(dataRoot, { recursive: true });
    const file = join(dataRoot, "jwt-secret");
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8").trim();
      if (raw.length >= 64) {
        this.key = Buffer.from(raw, "hex");
        return;
      }
    }
    const hex = randomBytes(48).toString("hex");
    writeFileSync(file, hex, { encoding: "utf8", mode: 0o600 });
    this.key = Buffer.from(hex, "hex");
  }

  sign(data: string): string {
    return base64UrlEncode(createHmac("sha256", this.key).update(data).digest());
  }
}

export class SessionManager {
  constructor(
    private readonly secret: JwtSecret,
    private readonly config: GatewayConfig,
  ) {}

  issueToken(user: { id: string; username: string }): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      iat: now,
      exp: now + this.config.sessionTtlSeconds,
    };
    const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = base64UrlEncode(JSON.stringify(payload));
    const signature = this.secret.sign(`${header}.${body}`);
    return `${header}.${body}.${signature}`;
  }

  /** 校验签名与过期时间；任何异常一律视为未登录。 */
  verifyToken(token: string | undefined | null): JwtPayload | null {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expected = this.secret.sign(`${header}.${body}`);
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (signatureBuffer.length !== expectedBuffer.length) return null;
    if (!timingSafeEqual(signatureBuffer, expectedBuffer)) return null;
    let payload: JwtPayload;
    try {
      payload = JSON.parse(base64UrlDecode(body).toString("utf8")) as JwtPayload;
    } catch {
      return null;
    }
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  }

  sessionCookie(token: string): string {
    return [
      `${sessionCookieName}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${this.config.sessionTtlSeconds}`,
    ].join("; ");
  }

  clearCookie(): string {
    return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}
