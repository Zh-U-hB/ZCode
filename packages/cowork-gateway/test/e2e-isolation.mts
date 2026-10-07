/**
 * 双租户数据隔离 RPC 级测试（轻量版：仅依赖 @zcode/rpc + ws）。
 * 前置：网关已在 8090 运行；alice/bob 已注册。
 * 结论三态：PASS / FAIL / LEAK。LEAK = 跨租户越权访问成功，属严重缺陷。
 */
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type ISocket,
} from "@zcode/rpc";
import { WebSocket } from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GATEWAY = process.env["COWORK_E2E_BASE"] ?? "http://127.0.0.1:8090";
const results: Array<{ name: string; status: "PASS" | "FAIL" | "LEAK"; detail?: string }> = [];

function record(name: string, status: "PASS" | "FAIL" | "LEAK", detail?: string): void {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function login(username: string, password: string): Promise<string> {
  const response = await fetch(`${GATEWAY}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const raw = response.headers.get("set-cookie") ?? "";
  const match = raw.match(/cowork_session=([^;]+)/);
  if (!response.ok || !match) {
    throw new Error(`login failed for ${username}: ${response.status}`);
  }
  return `cowork_session=${match[1]}`;
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

interface BareFileChannel {
  call(command: string, args: unknown[]): Promise<unknown>;
}

async function connectChannel(cookie: string, channelName: string): Promise<BareFileChannel> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${GATEWAY.replace("http", "ws")}/ws`, {
      headers: { cookie },
    });
    ws.once("error", (error) => reject(error));
    ws.once("open", () => {
      const client = new ChannelClient(new SocketProtocol(wrapNodeWebSocket(ws)));
      resolve(client.getChannel(channelName) as BareFileChannel);
    });
  });
}

async function connectFileChannel(cookie: string): Promise<BareFileChannel> {
  return connectChannel(cookie, "file");
}

async function tryReadText(
  channel: BareFileChannel,
  path: string,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  try {
    const slice = (await channel.call("readTextFile", [{ path }])) as {
      content?: string;
      text?: string;
    };
    const content = slice?.content ?? slice?.text ?? JSON.stringify(slice);
    return { ok: true, content: String(content).slice(0, 100) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function tryReaddir(
  channel: BareFileChannel,
  path: string,
): Promise<{ ok: true; names: string } | { ok: false; error: string }> {
  try {
    const entries = (await channel.call("readdir", [{ path }])) as Array<{ name: string }>;
    return { ok: true, names: entries.map((entry) => entry.name).join(",").slice(0, 100) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const aliceCookie = await login("alice", "alice-pass-123");
  const bobCookie = await login("bob", "bob-pass-45678");
  record("双用户同时登录", "PASS");

  const alice = await connectFileChannel(aliceCookie);
  const bob = await connectFileChannel(bobCookie);
  record("双用户并发 WS RPC 连接", "PASS");

  const aliceWorkspaceResult = (await alice.call("ensureConversationWorkspace", [{}])) as {
    path: string;
  };
  const aliceWorkspace = aliceWorkspaceResult?.path;
  if (!aliceWorkspace) {
    record("alice 会话工作区创建", "FAIL", "未返回路径");
    return;
  }
  mkdirSync(aliceWorkspace, { recursive: true });
  writeFileSync(join(aliceWorkspace, "alice-secret.txt"), "ALICE-SECRET-42");
  record("alice 会话工作区创建", "PASS", aliceWorkspace);

  // 回归：web 启动默认工作区（/api/server-info workspaces[0]，来自 ZCODE_SERVER_WORKSPACE）
  // 必须与 ensureConversationWorkspace 返回的会话工作区同路径；不一致时 tasks-index 按
  // workspace_key 精确匹配，历史任务在新开的工作区下永远查不到（表现为"会话历史丢失"）。
  const serverInfo = (await (await fetch(`${GATEWAY}/api/server-info`, {
    headers: { cookie: aliceCookie },
  })).json()) as { workspaces?: Array<{ path: string }> };
  const bootstrapWorkspace = serverInfo?.workspaces?.[0]?.path;
  record(
    "启动工作区与会话工作区一致",
    bootstrapWorkspace && bootstrapWorkspace === aliceWorkspace ? "PASS" : "FAIL",
    bootstrapWorkspace ? `${bootstrapWorkspace} vs ${aliceWorkspace}` : "server-info 未返回 workspaces",
  );

  // 回归：web 侧栏任务列表经 window-controller 通道聚合读取（useGlobalTaskList）。
  // 该服务原本只在 Electron 桌面 Host 装配；headless 用户 server 未注册时浏览器端
  // 查询全部静默失败，表现为侧栏永远"还没有任务"。这里直接调通道断言它可用且按
  // workspace scope 隔离返回（alice 查询自己的会话工作区不应报错、不应跨出 scope）。
  {
    const controller = await connectChannel(aliceCookie, "window-controller");
    try {
      const listResult = (await controller.call("listTaskList", [
        {
          kind: "active",
          workspaceScopes: [{ workspacePath: aliceWorkspace }],
          sortBy: "updated",
        },
      ])) as { items?: unknown[]; total?: number };
      record(
        "window-controller 侧栏任务通道可用",
        Array.isArray(listResult?.items) && typeof listResult?.total === "number" && listResult.total === 0
          ? "PASS"
          : "FAIL",
        JSON.stringify(listResult).slice(0, 120),
      );
    } catch (error) {
      record(
        "window-controller 侧栏任务通道可用",
        "FAIL",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const bobWorkspaceResult = (await bob.call("ensureConversationWorkspace", [{}])) as {
    path: string;
  };
  const bobWorkspace = bobWorkspaceResult?.path;
  if (!bobWorkspace) {
    record("bob 会话工作区创建", "FAIL", "未返回路径");
    return;
  }
  mkdirSync(bobWorkspace, { recursive: true });
  writeFileSync(join(bobWorkspace, "bob-secret.txt"), "BOB-SECRET-99");
  record("bob 会话工作区创建", "PASS", bobWorkspace);

  const selfRead = await tryReadText(alice, join(aliceWorkspace, "alice-secret.txt"));
  record(
    "alice 读取自己工作区文件",
    selfRead.ok && selfRead.content.includes("ALICE-SECRET-42") ? "PASS" : "FAIL",
    selfRead.ok ? selfRead.content : selfRead.error,
  );

  const crossRead = await tryReadText(alice, join(bobWorkspace, "bob-secret.txt"));
  record(
    "越权：alice 读 bob 工作区文件",
    crossRead.ok ? "LEAK" : "PASS",
    crossRead.ok ? `读到 ${crossRead.content}` : crossRead.error,
  );

  const coworkRoot = join(homedir(), ".zcode-cowork");
  const crossList = await tryReaddir(alice, coworkRoot);
  record(
    "越权：alice 列平台数据根目录",
    crossList.ok ? "LEAK" : "PASS",
    crossList.ok ? crossList.names : crossList.error,
  );

  const homeList = await tryReaddir(alice, homedir());
  record(
    "越权：alice 列用户主目录",
    homeList.ok ? "LEAK" : "PASS",
    homeList.ok ? homeList.names.slice(0, 60) : homeList.error,
  );

  const sysRead = await tryReadText(alice, "C:\\Windows\\win.ini");
  record(
    "越权：alice 读系统文件 win.ini",
    sysRead.ok ? "LEAK" : "PASS",
    sysRead.ok ? sysRead.content.slice(0, 40) : sysRead.error,
  );

  const bobSelf = await tryReadText(bob, join(bobWorkspace, "bob-secret.txt"));
  record(
    "bob 读取自己工作区文件",
    bobSelf.ok && bobSelf.content.includes("BOB-SECRET-99") ? "PASS" : "FAIL",
    bobSelf.ok ? bobSelf.content : bobSelf.error,
  );

  const leaks = results.filter((r) => r.status === "LEAK").length;
  const fails = results.filter((r) => r.status === "FAIL").length;
  console.log(
    `\n=== 总结: ${results.length} 项 | PASS ${results.length - leaks - fails} | FAIL ${fails} | LEAK ${leaks} ===`,
  );
  process.exit(leaks > 0 ? 2 : fails > 0 ? 1 : 0);
}

void main().catch((error: unknown) => {
  console.error("e2e-isolation crashed:", error);
  process.exitCode = 1;
});
