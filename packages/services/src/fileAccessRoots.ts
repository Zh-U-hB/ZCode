/* 多租户文件访问边界：以环境变量声明的根白名单约束服务层文件路径。 */
import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * 允许访问的根目录列表，分号分隔的绝对路径。
 * 未设置时不做任何限制（保持桌面/单用户 Web 的既有行为）；
 * cowork 网关等多租户宿主在拉起本进程时注入用户工作区与数据目录。
 */
const FILE_ACCESS_ROOTS_ENV = "ZCODE_FILE_ACCESS_ROOTS";

let cachedRoots: string[] | null = null;

function getAccessRoots(): string[] {
  if (cachedRoots === null) {
    const raw = process.env[FILE_ACCESS_ROOTS_ENV]?.trim();
    cachedRoots = raw
      ? raw
          .split(";")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => resolve(entry))
      : [];
  }
  return cachedRoots;
}

/** 当前进程是否启用了路径白名单。 */
export function isFileAccessRestricted(): boolean {
  return getAccessRoots().length > 0;
}

function toRealPathOrNull(pathValue: string): string | null {
  try {
    return realpathSync(pathValue);
  } catch {
    return null;
  }
}

function isWithinRoot(candidateReal: string, rootReal: string): boolean {
  const normalizedRoot = rootReal.endsWith(sep) ? rootReal.slice(0, -1) : rootReal;
  return candidateReal === normalizedRoot || candidateReal.startsWith(normalizedRoot + sep);
}

/** 校验单个路径位于白名单根内；越界抛错。 */
export function assertPathWithinAccessRoots(pathValue: string, operation: string): void {
  const roots = getAccessRoots();
  if (roots.length === 0) return;
  const lexical = isAbsolute(pathValue) ? pathValue : resolve(pathValue);
  // realpath 成功（路径存在，含 symlink/junction 已解析到目标）时只认解析结果，
  // 防止工作区内链接指向外部导致越界；路径不存在时退回词法路径，由后续 IO 自然报错。
  const real = toRealPathOrNull(lexical);
  for (const root of roots) {
    const rootReal = toRealPathOrNull(root) ?? root;
    if (real !== null ? isWithinRoot(real, rootReal) : isWithinRoot(lexical, rootReal)) {
      return;
    }
  }
  throw new Error(`路径超出允许的访问范围，操作被拒绝（${operation}）`);
}

/** 递归校验参数对象中的路径字段；字符串按路径处理，数组逐项处理。 */
function assertParamsWithinAccessRoots(
  value: unknown,
  pathFields: readonly string[],
  operation: string,
  depth = 0,
): void {
  if (depth > 3 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) {
      assertParamsWithinAccessRoots(item, pathFields, operation, depth + 1);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  for (const field of pathFields) {
    const candidate = record[field];
    if (typeof candidate === "string" && candidate.trim()) {
      assertPathWithinAccessRoots(candidate, operation);
    } else if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === "string" && item.trim()) {
          assertPathWithinAccessRoots(item, operation);
        }
      }
    }
  }
}

/**
 * 以 Proxy 包装服务对象：方法调用前先校验首参中的路径字段。
 * 仅在设置了白名单时生效，其余形态返回原对象。
 */
export function guardServicePathParams<T extends object>(
  service: T,
  pathFields: readonly string[],
  serviceLabel: string,
): T {
  if (!isFileAccessRestricted()) {
    return service;
  }
  return new Proxy(service, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "symbol" || typeof value !== "function") {
        return value;
      }
      return function guardedMethod(this: unknown, ...args: unknown[]) {
        const first = args[0];
        if (first !== null && typeof first === "object") {
          assertParamsWithinAccessRoots(first, pathFields, `${serviceLabel}.${String(prop)}`);
        }
        return (value as (...fnArgs: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
