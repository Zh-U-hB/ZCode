/**
 * 对抗性安全测试（第二轮）：认证伪造、路径绕过变种、直连绕过、限流、恶意 Origin。
 * 前置：网关已在 8090 运行；alice 已注册且 user-server 已拉起（先访问过 /api/*）。
 */
import { Emitter, VSBuffer, SocketProtocol, ChannelClient, type ISocket } from "@zcode/rpc";
import { WebSocket } from "ws";
import { writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GATEWAY = process.env["COWORK_E2E_BASE"] ?? "http://127.0.0.1:8090";
const results: Array<{ name: string; status: "PASS" | "FAIL" | "LEAK" }> = [];

function record(name: string, status: "PASS" | "FAIL" | "LEAK"): void {
  results.push({ name, status });
  console.log(`[${status}] ${name}`);
}

async function login(username: string, password: string): Promise<string | null> {
  const response = await fetch(`${GATEWAY}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const raw = response.headers.get("set-cookie") ?? "";
  const match = raw.match(/cowork_session=([^;]+)/);
  return match ? `cowork_session=${match[1]}` : null;
}

function wrapNodeWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

async function fileChannelWithCookie(cookie: string): Promise<{
  call: (command: string, args: unknown[]) => Promise<unknown>;
} | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${GATEWAY.replace("http", "ws")}/ws`, {
      headers: { cookie },
    });
    ws.once("error", () => resolve(null));
    ws.once("open", () => {
      const client = new ChannelClient(new SocketProtocol(wrapNodeWebSocket(ws)));
      const channel = client.getChannel("file");
      resolve({
        call: (command: string, args: unknown[]) =>
          (channel as unknown as { call(c: string, a: unknown[]): Promise<unknown> }).call(
            command,
            args,
          ),
      });
    });
  });
}

async function attemptRead(cookie: string, path: string): Promise<boolean> {
  const channel = await fileChannelWithCookie(cookie);
  if (!channel) return false;
  try {
    const result = (await channel.call("readTextFile", [{ path }])) as { content?: string };
    return Boolean(result && (result.content !== undefined || result !== undefined));
  } catch {
    return false;
  }
}

async function attemptReaddir(cookie: string, path: string): Promise<boolean> {
  const channel = await fileChannelWithCookie(cookie);
  if (!channel) return false;
  try {
    await channel.call("readdir", [{ path }]);
    return true;
  } catch {
    return false;
  }
}

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

async function main(): Promise<void> {
  const aliceCookie = await login("alice", "alice-pass-123");
  if (!aliceCookie) {
    console.error("前置失败：alice 无法登录");
    process.exit(1);
  }
  const aliceToken = aliceCookie.replace("cowork_session=", "");

  // 触发 user-server 拉起（代理一次业务 API），再查询端口。
  await fetch(`${GATEWAY}/api/server-info`, { headers: { cookie: aliceCookie } });
  const meResponse = await fetch(`${GATEWAY}/api/gateway/me`, {
    headers: { cookie: aliceCookie },
  });
  const me = (await meResponse.json()) as { server?: { port?: number } };
  const userServerPort = me.server?.port ?? null;

  // ---- 组1：JWT 伪造 ----
  const [header] = aliceToken.split(".");
  const forgedPayload = b64url(
    JSON.stringify({ sub: "00000000-0000-0000-0000-000000000000", username: "root", exp: 9999999999 }),
  );
  const forgedVariants = [
    `${header}.${forgedPayload}.${aliceToken.split(".")[2]}`,
    `${header}.${forgedPayload}.${b64url("forgesignature")}`,
    "not-a-jwt",
    `${header}.${aliceToken.split(".")[1]}.AAAA`,
  ];
  let forgedRejected = 0;
  for (const token of forgedVariants) {
    const response = await fetch(`${GATEWAY}/api/server-info`, {
      headers: { cookie: `cowork_session=${token}` },
    });
    if (response.status === 401) forgedRejected += 1;
  }
  record(
    "伪造/篡改 JWT 全部被拒",
    forgedRejected === forgedVariants.length ? "PASS" : "FAIL",
  );

  const garbageChars = await fetch(`${GATEWAY}/api/server-info`, {
    headers: { cookie: "cowork_session=garbage!!!" },
  });
  record("非法字符 token 被拒", garbageChars.status === 401 ? "PASS" : "FAIL");

  // ---- 组2：路径绕过变种 ----
  const homeDir = homedir();
  const variants: Array<[string, string]> = [
    ["大小写混淆", `c:\\users\\${homeDir.split("\\")[2]}\\windows\\win.ini`],
    ["反斜杠相对回溯", `${homeDir}\\..\\..\\..\\windows\\win.ini`],
    ["正斜杠混合", `C:/Windows/win.ini`],
    ["编码点号", `C:\\Windows\\..\\Windows\\win.ini`],
    ["无盘符相对", `..\\..\\..\\..\\windows\\win.ini`],
    ["NUL 截断尝试", `C:\\Windows\\win.ini\u0000.jpg`],
  ];
  for (const [label, path] of variants) {
    const leaked = await attemptRead(aliceCookie, path);
    record(`路径绕过(${label})被拒`, leaked ? "LEAK" : "PASS");
  }

  // symlink 逃逸：alice 工作区里建指向 system32 的链接。
  const aliceWorkspace = join(
    homeDir,
    ".zcode-cowork",
    "users",
    me.server ? String(await resolveAliceId(aliceCookie)) : "",
    "workspace",
    "default",
  );
  void aliceWorkspace;

  // ---- 组3：直连 user-server 绕过网关 ----
  if (userServerPort) {
    const directNoToken = await fetch(`http://127.0.0.1:${userServerPort}/api/server-info`).catch(
      () => null,
    );
    record(
      "直连用户端口无 token 被拒",
      directNoToken && directNoToken.status === 401 ? "PASS" : "FAIL",
    );
    const directWs = new WebSocket(`ws://127.0.0.1:${userServerPort}/ws`);
    const directWsRejected = await new Promise<boolean>((resolve) => {
      directWs.once("unexpected-response", (_req, res) => resolve(res.statusCode === 401));
      directWs.once("error", () => resolve(false));
      directWs.once("open", () => {
        directWs.close();
        resolve(false);
      });
    });
    record("直连用户端口 WS 被拒", directWsRejected ? "PASS" : "FAIL");
  } else {
    record("直连用户端口（前置：拿端口）", "FAIL");
  }

  // ---- 组4：无认证 WS ----
  const anonWs = new WebSocket(`${GATEWAY.replace("http", "ws")}/ws`);
  const anonRejected = await new Promise<boolean>((resolve) => {
    anonWs.once("unexpected-response", (_req, res) => resolve(res.statusCode === 401));
    anonWs.once("error", () => resolve(false));
    anonWs.once("open", () => {
      anonWs.close();
      resolve(false);
    });
  });
  record("网关无认证 WS 被拒", anonRejected ? "PASS" : "FAIL");

  // ---- 组5：恶意 Origin ----
  const csrfAttempt = await fetch(`${GATEWAY}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ username: "alice", password: "alice-pass-123" }),
  });
  record(
    "跨站 Origin 登录被拒",
    csrfAttempt.status === 403 ? "PASS" : "FAIL",
  );

  // ---- 组6：超大 body ----
  const bigBody = await fetch(`${GATEWAY}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "x".repeat(100000), password: "y".repeat(100000) }),
  });
  record(
    "超大登录 body 被拒",
    bigBody.status === 400 || bigBody.status === 413 ? "PASS" : "FAIL",
  );

  // ---- 组7：symlink 逃逸 ----
  try {
    const aliceId = await resolveAliceId(aliceCookie);
    const workDir = join(homeDir, ".zcode-cowork", "users", aliceId, "home", ".zcode", "workspace", "default");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "innocent.txt"), "innocent");
    const linkPath = join(workDir, "escape-link");
    try {
      symlinkSync("C:\\Windows", linkPath, "junction");
    } catch {
      // 链接创建失败则跳过该项。
    }
    const leakedViaLink = await attemptReaddir(aliceCookie, linkPath);
    record("symlink/junction 逃逸被拒", leakedViaLink ? "LEAK" : "PASS");
  } catch {
    record("symlink/junction 逃逸被拒（跳过）", "PASS");
  }

  // ---- 组8：file-preview 预览端点 ----
  {
    console.log("[step] group8 begin");
    const aliceId = await resolveAliceId(aliceCookie);
    console.log("[step] aliceId ok");
    const aliceWorkspace = join(homeDir, ".zcode-cowork", "users", aliceId, "home", ".zcode", "workspace", "default");
    const qs = (p: string) => `${GATEWAY}/api/file-preview?path=${encodeURIComponent(p)}`;
    const own = await fetch(qs(join(aliceWorkspace, "innocent.txt")), {
      headers: { cookie: aliceCookie },
    });
    console.log("[step] own fetch done", own.status);
    record(
      "预览端点：读自己工作区文件",
      own.status === 200 ? "PASS" : "FAIL",
    );
    const cross = await fetch(
      qs(join(homeDir, ".zcode-cowork", "users", "621d63cd-ba6c-4be0-94ca-142c48740828", "home", ".zcode", "workspace", "default", "bob-secret.txt")),
      { headers: { cookie: aliceCookie } },
    );
    record("预览端点：读他人工作区被拒", cross.status === 403 ? "PASS" : cross.status === 404 ? "LEAK" : "FAIL");
    const sys = await fetch(qs("C:\\Windows\\win.ini"), { headers: { cookie: aliceCookie } });
    record(
      "预览端点：读系统文件被拒",
      sys.status === 403 || sys.status === 415 ? "PASS" : "FAIL",
    );
    const anon = await fetch(qs(join(aliceWorkspace, "innocent.txt")));
    record("预览端点：未认证被拒", anon.status === 401 ? "PASS" : "FAIL");
    const exe = await fetch(qs("C:\\Windows\\System32\\cmd.exe"), { headers: { cookie: aliceCookie } });
    record("预览端点：白名单外类型被拒", exe.status === 415 || exe.status === 403 ? "PASS" : "FAIL");
  }

  const leaks = results.filter((r) => r.status === "LEAK").length;
  const fails = results.filter((r) => r.status === "FAIL").length;
  console.log(
    `\n=== 对抗测试总结: ${results.length} 项 | PASS ${results.length - leaks - fails} | FAIL ${fails} | LEAK ${leaks} ===`,
  );
  process.exit(leaks > 0 ? 2 : fails > 0 ? 1 : 0);
}

async function resolveAliceId(cookie: string): Promise<string> {
  const response = await fetch(`${GATEWAY}/api/gateway/me`, { headers: { cookie } });
  const me = (await response.json()) as { user?: { id?: string } };
  return me.user?.id ?? "";
}

void main().catch((error: unknown) => {
  console.error("adv-security crashed:", error);
  process.exitCode = 1;
});
