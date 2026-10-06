import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./log.js";

const log = createLogger("invite-code");

/** 邀请码格式：12 位数字与大/小写字母。 */
export const inviteCodePattern = /^[0-9A-Za-z]{12}$/;

function generateInviteCode(): string {
  // 12 位，取随机字节的 base36 投影并截断；拒绝含歧义字符不需要，仅保证字母数字。
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(12);
  let code = "";
  for (let i = 0; i < 12; i += 1) {
    code += alphabet[bytes[i]! % alphabet.length];
  }
  return code;
}

/**
 * 平台唯一邀请码：环境变量 COWORK_INVITE_CODE 优先；
 * 否则首次启动生成并持久化到 {dataRoot}/invite-code（后续重启复用，避免失效）。
 * 校验使用恒定时间比较；修改文件内容即可轮换。
 */
export class InviteCodeStore {
  private readonly code: string;

  constructor(dataRoot: string) {
    mkdirSync(dataRoot, { recursive: true });
    const envCode = process.env["COWORK_INVITE_CODE"]?.trim();
    if (envCode) {
      if (!inviteCodePattern.test(envCode)) {
        throw new Error("COWORK_INVITE_CODE 必须是 12 位数字或字母");
      }
      this.code = envCode;
      return;
    }
    const file = join(dataRoot, "invite-code");
    if (existsSync(file)) {
      const stored = readFileSync(file, "utf8").trim();
      if (inviteCodePattern.test(stored)) {
        this.code = stored;
        return;
      }
      log.warn("已持久化的邀请码格式非法，将重新生成", { file });
    }
    const generated = generateInviteCode();
    writeFileSync(file, generated, { encoding: "utf8", mode: 0o600 });
    this.code = generated;
    // 码本身不落日志；运营者通过文件查看。
    log.info("已生成注册邀请码（查看文件获取）", { file });
  }

  /** 恒定时间校验邀请码；任何格式不符直接拒绝。 */
  verify(input: string): boolean {
    if (typeof input !== "string" || !inviteCodePattern.test(input)) {
      return false;
    }
    const a = Buffer.from(input, "utf8");
    const b = Buffer.from(this.code, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
