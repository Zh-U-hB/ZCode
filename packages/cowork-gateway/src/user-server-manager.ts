import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server as NetServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdirSync, appendFileSync, existsSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { GatewayConfig } from "./config.js";
import { createLogger } from "./log.js";

const log = createLogger("user-server-manager");

/** 单用户 server 日志轮转上限。 */
const USER_LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface UserServerRecord {
  userId: string;
  username: string;
  port: number;
  /** 网关访问该用户 server 的随机 token；仅存于内存。 */
  accessToken: string;
  child: ChildProcess;
  dataDir: string;
  workspaceDir: string;
  startedAt: number;
  lastActiveAt: number;
  /** 活跃代理连接计数；>0 时闲置回收永不触发。 */
  activeConnections: number;
  /** 显式停止标记，避免把正常关闭当成崩溃。 */
  stopping: boolean;
}

interface LaunchResult {
  ok: true;
  record: UserServerRecord;
}

interface LaunchFailure {
  ok: false;
  error: string;
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** 端口占用探测：能 bind 即视为空闲；存在与子进程启动的竞态，失败时由健康检查兜底重试。 */
async function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe: NetServer = createServer();
    probe.once("error", () => resolvePromise(false));
    probe.once("listening", () => {
      probe.close(() => resolvePromise(true));
    });
    probe.listen(port, host);
  });
}

function rotateUserLogIfNeeded(logFile: string): void {
  try {
    if (!existsSync(logFile)) return;
    if (statSync(logFile).size > USER_LOG_MAX_BYTES) {
      renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // 轮转失败不影响写入。
  }
}

export class UserServerManager {
  private readonly servers = new Map<string, UserServerRecord>();
  private readonly starting = new Map<string, Promise<LaunchResult | LaunchFailure>>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: GatewayConfig,
    private readonly onServerExit?: (userId: string, username: string) => void,
  ) {}

  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, 60_000);
    this.sweepTimer.unref();
  }

  async sweep(): Promise<void> {
    const now = Date.now();
    for (const record of [...this.servers.values()]) {
      if (record.activeConnections > 0) continue;
      if (now - record.lastActiveAt < this.config.userServerIdleMs) continue;
      await this.stop(record.userId, "idle-timeout");
    }
  }

  /** 取活跃 server；不存在或已死则拉起。并发调用共享同一次启动。 */
  async acquire(userId: string, username: string): Promise<LaunchResult | LaunchFailure> {
    const existing = this.servers.get(userId);
    if (existing && existing.child.exitCode === null && !existing.stopping) {
      existing.lastActiveAt = Date.now();
      return { ok: true, record: existing };
    }
    if (existing) {
      this.servers.delete(userId);
    }
    let pending = this.starting.get(userId);
    if (!pending) {
      pending = this.launch(userId, username);
      this.starting.set(userId, pending);
      pending.finally(() => this.starting.delete(userId)).catch(() => {});
    }
    return pending;
  }

  /** 代理层持有连接时调用；连接断开必须 release。 */
  beginConnection(record: UserServerRecord): void {
    record.activeConnections += 1;
    record.lastActiveAt = Date.now();
  }

  endConnection(record: UserServerRecord): void {
    record.activeConnections = Math.max(0, record.activeConnections - 1);
    record.lastActiveAt = Date.now();
  }

  getRecord(userId: string): UserServerRecord | null {
    return this.servers.get(userId) ?? null;
  }

  describe(userId: string): {
    running: boolean;
    port: number | null;
    activeConnections: number;
    startedAt: number | null;
  } {
    const record = this.servers.get(userId);
    if (!record) {
      return { running: false, port: null, activeConnections: 0, startedAt: null };
    }
    return {
      running: record.child.exitCode === null && !record.stopping,
      port: record.port,
      activeConnections: record.activeConnections,
      startedAt: record.startedAt,
    };
  }

  private async launch(userId: string, username: string): Promise<LaunchResult | LaunchFailure> {
    const userRoot = join(this.config.dataRoot, "users", userId);
    // 每用户虚拟 home：覆盖 HOME/USERPROFILE 后，services 内所有 homedir()/resolveUserHomeDir()
    // 派生的 .zcode 路径（设置、hooks、插件、命令、遥测）全部落在用户私有目录，租户互不可见。
    const userHome = join(userRoot, "home");
    const dataDir = userHome;
    const workspaceDir = join(userRoot, "workspace", "default");
    const logsDir = join(this.config.dataRoot, "logs", "users");
    for (const dir of [userRoot, userHome, workspaceDir, logsDir]) {
      mkdirSync(dir, { recursive: true });
    }

    const port = await this.allocatePort();
    if (!port) {
      return { ok: false, error: "端口池耗尽，无法启动用户服务" };
    }
    const accessToken = generateToken();
    const serverEntry = join(this.config.repoRoot, "packages", "server", "dist", "entry-http.js");
    if (!existsSync(serverEntry)) {
      return {
        ok: false,
        error: "server 构建产物缺失，请先执行 pnpm --filter @zcode/server exec tsup",
      };
    }

    const logFile = join(logsDir, `${userId}.log`);
    rotateUserLogIfNeeded(logFile);

    const child = spawn(process.execPath, [serverEntry], {
      cwd: this.config.repoRoot,
      env: {
        ...process.env,
        PORT: String(port),
        ZCODE_SERVER_HOST: "127.0.0.1",
        ZCODE_SERVER_AUTH_TOKEN: accessToken,
        ZCODE_DATA_BASE_DIR: dataDir,
        // 关键隔离点：Node os.homedir() 读 USERPROFILE(HOME)；
        // services 内多处绕过 getAppConfigDir 的 home 解析随之全部指向用户虚拟 home。
        HOME: userHome,
        USERPROFILE: userHome,
        ZCODE_SERVER_WORKSPACE: workspaceDir,
        ZCODE_SERVER_ID: `cowork-${username}`,
        ZCODE_SERVER_NAME: `${username} 的 Cowork 工作区`,
        // 租户路径边界：file/git/terminal 服务只允许访问本用户的工作区与数据目录。
        ZCODE_FILE_ACCESS_ROOTS: `${workspaceDir};${userHome}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const appendLog = (chunk: Buffer) => {
      try {
        appendFileSync(logFile, chunk);
      } catch {
        // 磁盘写失败仅丢弃日志。
      }
    };
    child.stdout?.on("data", appendLog);
    child.stderr?.on("data", appendLog);

    const record: UserServerRecord = {
      userId,
      username,
      port,
      accessToken,
      child,
      dataDir,
      workspaceDir,
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      activeConnections: 0,
      stopping: false,
    };
    this.servers.set(userId, record);

    child.once("exit", (code, signal) => {
      const known = this.servers.get(userId);
      if (known === record) {
        this.servers.delete(userId);
      }
      if (!record.stopping) {
        log.warn("用户 server 异常退出", {
          userId,
          username,
          code,
          signal: signal ?? null,
        });
        this.onServerExit?.(userId, username);
      }
    });

    const healthy = await this.waitForHealth(record);
    if (!healthy.ok) {
      await this.stop(userId, "health-check-failed");
      return { ok: false, error: healthy.error };
    }
    log.info("用户 server 已启动", { userId, username, port });
    return { ok: true, record };
  }

  private async allocatePort(): Promise<number | null> {
    const { userServerPortMin: min, userServerPortMax: max } = this.config;
    const used = new Set([...this.servers.values()].map((record) => record.port));
    const candidates: number[] = [];
    const span = max - min + 1;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = min + Math.floor(Math.random() * span);
      if (!used.has(port) && !candidates.includes(port)) {
        candidates.push(port);
      }
      if (candidates.length >= 5) break;
    }
    for (const port of candidates) {
      if (await isPortAvailable(port, "127.0.0.1")) {
        return port;
      }
    }
    return null;
  }

  private waitForHealth(
    record: UserServerRecord,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const deadline = Date.now() + this.config.userServerStartTimeoutMs;
    const infoUrl = `http://127.0.0.1:${record.port}/api/server-info?token=${encodeURIComponent(record.accessToken)}`;
    const attempt = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (record.child.exitCode !== null) {
        return { ok: false, error: "用户服务进程提前退出，详情见用户日志" };
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(infoUrl, { signal: controller.signal });
        clearTimeout(timer);
        if (response.ok) return { ok: true };
      } catch {
        // 继续等待。
      }
      if (Date.now() > deadline) {
        return { ok: false, error: "用户服务启动超时" };
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      return attempt();
    };
    return attempt();
  }

  async stop(userId: string, reason: string): Promise<void> {
    const record = this.servers.get(userId);
    if (!record) return;
    record.stopping = true;
    log.info("停止用户 server", { userId, username: record.username, reason });
    const child = record.child;
    const exited = new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
    });
    const kill = () => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    };
    try {
      child.kill("SIGTERM");
    } catch {
      kill();
    }
    const timeout = setTimeout(kill, 8000);
    timeout.unref();
    await exited;
    clearTimeout(timeout);
    this.servers.delete(userId);
  }

  async stopAll(reason: string): Promise<void> {
    await Promise.all([...this.servers.keys()].map((userId) => this.stop(userId, reason)));
  }

  /** 数据目录指纹（不含内容），供隔离测试使用。 */
  dataDirFingerprint(userId: string): string | null {
    const record = this.servers.get(userId);
    if (!record) return null;
    return createHash("sha256").update(record.dataDir).digest("hex").slice(0, 12);
  }
}
