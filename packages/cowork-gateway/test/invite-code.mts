/**
 * 邀请码注册门槛测试。
 * 前置：网关已在 8090 运行。邀请码取自 {dataRoot}/invite-code 或 COWORK_INVITE_CODE。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GATEWAY = process.env["COWORK_E2E_BASE"] ?? "http://127.0.0.1:8090";
const dataRoot = process.env["COWORK_DATA_ROOT"] ?? join(homedir(), ".zcode-cowork");
const realCode = process.env["COWORK_INVITE_CODE"]?.trim() ?? readFileSync(join(dataRoot, "invite-code"), "utf8").trim();

const results: Array<{ name: string; pass: boolean }> = [];
function record(name: string, pass: boolean): void {
  results.push({ name, pass });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}`);
}

async function register(body: Record<string, unknown>): Promise<number> {
  const response = await fetch(`${GATEWAY}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.status;
}

const stamp = Date.now().toString(36);

async function main(): Promise<void> {
  record(
    "无邀请码注册被拒",
    (await register({ username: `nc${stamp}`, password: "password-123" })) === 403,
  );
  record(
    "错误邀请码被拒",
    (await register({ username: `wc${stamp}`, password: "password-123", inviteCode: "XXXXXXXXXXXX" })) === 403,
  );
  record(
    "大小写敏感：改变大小写被拒",
    (await register({ username: `cc${stamp}`, password: "password-123", inviteCode: realCode.toUpperCase() === realCode ? realCode.toLowerCase() : realCode.toUpperCase() })) === 403,
  );
  record(
    "格式非法（11 位）被拒",
    (await register({ username: `s1${stamp}`, password: "password-123", inviteCode: realCode.slice(0, 11) })) === 403,
  );
  record(
    "正确邀请码注册成功",
    (await register({ username: `ok${stamp}`, password: "password-123", inviteCode: realCode })) === 200,
  );
  record(
    "正确码 + 重复用户名被拒",
    (await register({ username: `ok${stamp}`, password: "password-123", inviteCode: realCode })) === 400,
  );

  const fails = results.filter((r) => !r.pass).length;
  console.log(`\n=== 邀请码测试总结: ${results.length} 项 | PASS ${results.length - fails} | FAIL ${fails} ===`);
  process.exit(fails > 0 ? 1 : 0);
}

void main().catch((error: unknown) => {
  console.error("invite-code test crashed:", error);
  process.exitCode = 1;
});
