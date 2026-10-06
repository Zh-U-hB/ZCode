import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

let logDir: string | null = null;

export function initLog(dir: string): void {
  logDir = dir;
}

function formatLine(level: string, scope: string, args: unknown[]): string {
  const message = args
    .map((item) => {
      if (typeof item === "string") return item;
      if (item instanceof Error) return `${item.name}: ${item.message}`;
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .join(" ");
  return `${new Date().toISOString()} [${level}] [${scope}] ${message}`;
}

export function createLogger(scope: string) {
  const write = (level: string, args: unknown[]) => {
    const line = formatLine(level, scope, args);
    console.log(line);
    if (logDir) {
      // 日志落盘失败不得影响服务本身。
      void appendFile(join(logDir, "gateway.log"), line + "\n", "utf8").catch(() => {});
    }
  };
  return {
    info: (...args: unknown[]) => write("info", args),
    warn: (...args: unknown[]) => write("warn", args),
    error: (...args: unknown[]) => write("error", args),
  };
}
