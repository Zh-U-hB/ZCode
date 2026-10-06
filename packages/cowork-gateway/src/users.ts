import { randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** scrypt 参数：N=2^14, r=8, p=1，输出 64 字节。 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  passwordSalt: string;
  createdAt: number;
  updatedAt: number;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  createdAt: number;
}

export const usernamePattern = /^[a-zA-Z0-9_-]{3,32}$/;

/** promisify 无法正确推断 scrypt 的 options 重载，手写 Promise 包装。 */
function scrypt(
  password: string,
  salt: string,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/** SQLite 行为蛇形列名，统一映射为驼峰后再交给上层。 */
interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  created_at: number;
  updated_at: number;
}

function mapRow(row: UserRow | undefined): UserRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublicUser(row: UserRecord): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    createdAt: row.createdAt,
  };
}

async function hashPassword(
  password: string,
): Promise<{ hash: string; salt: string }> {
  const salt = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const derived = (await scrypt(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer;
  return { hash: derived.toString("hex"), salt };
}

async function verifyPassword(
  password: string,
  salt: string,
  expectedHashHex: string,
): Promise<boolean> {
  const expected = Buffer.from(expectedHashHex, "hex");
  if (expected.length !== SCRYPT_KEYLEN) {
    return false;
  }
  const derived = (await scrypt(password.normalize("NFKC"), salt, expected.length, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer;
  return timingSafeEqual(derived, expected);
}

export class UserStore {
  private db: DatabaseSync;

  constructor(dataRoot: string) {
    mkdirSync(join(dataRoot, "users"), { recursive: true });
    this.db = new DatabaseSync(join(dataRoot, "gateway.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);");
  }

  countUsers(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    return row.n;
  }

  findByUsername(username: string): UserRecord | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
      .get(username) as UserRow | undefined;
    return mapRow(row);
  }

  findById(id: string): UserRecord | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
      | UserRow
      | undefined;
    return mapRow(row);
  }

  async createUser(input: {
    username: string;
    password: string;
    displayName?: string;
  }): Promise<{ ok: true; user: PublicUser } | { ok: false; error: string }> {
    if (!usernamePattern.test(input.username)) {
      return { ok: false, error: "用户名需为 3-32 位字母、数字、下划线或短横线" };
    }
    if (typeof input.password !== "string" || input.password.length < 8) {
      return { ok: false, error: "密码至少需要 8 个字符" };
    }
    if (input.password.length > 256) {
      return { ok: false, error: "密码过长" };
    }
    if (this.findByUsername(input.username)) {
      return { ok: false, error: "用户名已被占用" };
    }
    const displayName = (input.displayName ?? "").trim().slice(0, 64) || input.username;
    const { hash, salt } = await hashPassword(input.password);
    const now = Date.now();
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO users (id, username, display_name, password_hash, password_salt, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.username, displayName, hash, salt, now, now);
    } catch (error) {
      // 并发注册同名时 UNIQUE 约束兜底；其它数据库错误如实返回失败原因。
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE/i.test(message)) {
        return { ok: false, error: "用户名已被占用" };
      }
      return { ok: false, error: "账户创建失败，请稍后重试" };
    }
    return { ok: true, user: { id, username: input.username, displayName, createdAt: now } };
  }

  async verifyCredentials(
    username: string,
    password: string,
  ): Promise<PublicUser | null> {
    const row = this.findByUsername(username);
    if (!row) {
      // 对不存在用户也执行一次派生，避免通过响应时间枚举用户名。
      await hashPassword(password);
      return null;
    }
    const valid = await verifyPassword(password, row.passwordSalt, row.passwordHash);
    return valid ? toPublicUser(row) : null;
  }

  close(): void {
    this.db.close();
  }
}
