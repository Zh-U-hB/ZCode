import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 本包根目录（packages/cowork-gateway）。 */
const packageDir = resolve(fileURLToPath(import.meta.url), "..", "..");

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function readEnvString(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw || fallback;
}

export interface GatewayConfig {
  /** 网关监听端口。 */
  port: number;
  /** 网关监听地址；默认仅回环，外部访问需显式改配置并自负安全责任。 */
  host: string;
  /** cowork 平台数据根目录（用户库、密钥、日志、各用户数据）。 */
  dataRoot: string;
  /** ZCode monorepo 仓库根（用于定位 server 构建产物与 agent bundle）。 */
  repoRoot: string;
  /** Web 前端静态产物目录。 */
  webDist: string;
  /** 平台最大用户数；注册超过该数返回 403。 */
  maxUsers: number;
  /** 用户 server 闲置回收阈值（毫秒）。 */
  userServerIdleMs: number;
  /** 用户 server 端口池下界（含）。 */
  userServerPortMin: number;
  /** 用户 server 端口池上界（含）。 */
  userServerPortMax: number;
  /** 用户 server 启动健康检查超时（毫秒）。 */
  userServerStartTimeoutMs: number;
  /** 单请求 body 上限（字节），仅网关自解析的路由使用。 */
  maxAuthBodyBytes: number;
  /** OAuth token 交换透传目标。 */
  endpointOrigin: string;
  /** 会话有效期（秒）。 */
  sessionTtlSeconds: number;
}

export function loadConfig(): GatewayConfig {
  const dataRoot = resolve(readEnvString("COWORK_DATA_ROOT", join(homedir(), ".zcode-cowork")));
  return {
    port: readEnvInt("COWORK_GATEWAY_PORT", 8090),
    host: readEnvString("COWORK_GATEWAY_HOST", "127.0.0.1"),
    dataRoot,
    repoRoot: resolve(readEnvString("COWORK_REPO_ROOT", join(packageDir, "..", ".."))),
    webDist: resolve(readEnvString("COWORK_WEB_DIST", join(packageDir, "..", "web", "dist"))),
    maxUsers: readEnvInt("COWORK_MAX_USERS", 50),
    userServerIdleMs: readEnvInt("COWORK_USER_SERVER_IDLE_MS", 30 * 60 * 1000),
    userServerPortMin: readEnvInt("COWORK_USER_SERVER_PORT_MIN", 31000),
    userServerPortMax: readEnvInt("COWORK_USER_SERVER_PORT_MAX", 31999),
    userServerStartTimeoutMs: readEnvInt("COWORK_USER_SERVER_START_TIMEOUT_MS", 90_000),
    maxAuthBodyBytes: readEnvInt("COWORK_MAX_AUTH_BODY_BYTES", 8 * 1024),
    endpointOrigin: readEnvString("COWORK_ENDPOINT_ORIGIN", "https://zcode.z.ai"),
    sessionTtlSeconds: readEnvInt("COWORK_SESSION_TTL_SECONDS", 7 * 24 * 3600),
  };
}
