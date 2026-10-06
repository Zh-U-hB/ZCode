import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { initLog, createLogger } from "./log.js";
import { UserStore } from "./users.js";
import { JwtSecret, SessionManager } from "./auth.js";
import { InviteCodeStore } from "./invite-code.js";
import { UserServerManager } from "./user-server-manager.js";
import { createGateway } from "./gateway.js";

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(join(config.dataRoot, "logs"), { recursive: true });
  initLog(join(config.dataRoot, "logs"));
  const log = createLogger("main");

  const users = new UserStore(config.dataRoot);
  const inviteCodes = new InviteCodeStore(config.dataRoot);
  const sessions = new SessionManager(new JwtSecret(config.dataRoot), config);
  const manager = new UserServerManager(config, (userId, username) => {
    log.warn("用户 server 崩溃，已从池中移除；下次请求将自动重启", { userId, username });
  });
  manager.startSweep();

  const gateway = createGateway({ config, users, sessions, manager, inviteCodes });
  gateway.listen(config.port, config.host, () => {
    log.info("Cowork 网关已启动", {
      url: `http://${config.host === "127.0.0.1" ? "localhost" : config.host}:${config.port}`,
      dataRoot: config.dataRoot,
      maxUsers: config.maxUsers,
    });
    log.info("Web 前端产物目录", { webDist: config.webDist });
  });

  const shutdown = (signal: string) => {
    log.info("收到退出信号，正在停止全部用户 server", { signal });
    void manager.stopAll(signal).finally(() => {
      users.close();
      gateway.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  console.error("[cowork-gateway] startup failed:", error);
  process.exitCode = 1;
});
