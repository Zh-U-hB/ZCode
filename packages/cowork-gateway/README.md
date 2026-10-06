# ZCode Cowork Gateway — 多用户隔离 Web 平台

在 ZCode Web 端之上叠加的多租户层：独立账户登录、每用户独立工作区与数据、进程级沙箱隔离、多用户并发，形态类似网页端 Claude Cowork。

## 架构

```
浏览器（现有 @zcode/ui Web 前端，零改动复用）
  │  http://localhost:8090（仅回环监听）
  ▼
Cowork 网关（本包，Node 内置模块实现，零第三方运行时依赖）
  ├─ /auth/*              注册/登录/登出（SQLite 用户库 + scrypt + JWT HttpOnly Cookie）
  ├─ /login               内置登录页
  ├─ /api/gateway/me      用户信息 + 个人 server 状态
  ├─ /api/v1/oauth/token  模型账号 OAuth 透传
  ├─ 静态文件              packages/web/dist（SPA fallback）
  └─ /api/*、/ws          按 JWT 路由到该用户的 user-server（HTTP 流式 + WS 二进制透传代理）
        │
        ├─ alice → user-server 进程（127.0.0.1:31xxx，随机 token）
        │            HOME/USERPROFILE = ~/.zcode-cowork/users/<id>/home
        │            ZCODE_FILE_ACCESS_ROOTS = 工作区;用户home
        │            └─ spawn zcode-agent 子进程（stdio JSON-RPC）
        └─ bob   → user-server 进程（独立端口/数据/工作区/agent）
```

### 隔离层次（由外到内）

1. **网关认证层**：所有 `/api`、`/ws`、页面路由要求 JWT 会话；WS 升级与写请求校验同源 Origin；登录接口按 IP/用户名双维度滑动窗口限流。
2. **进程层**：每用户一个独立 `@zcode/server` 子进程（独立端口 + 每用户随机 token，仅监听 127.0.0.1），崩溃互不影响；agent 是 user-server 的子进程，天然按用户分组。
3. **文件系统层**：
   - **虚拟 home**：user-server 以 `HOME/USERPROFILE` 指向用户私有目录，services 内全部 `homedir()` 派生路径（设置 recentProjects、hooks、插件、命令、遥测状态）自动隔离；
   - **路径白名单**：`packages/services/src/fileAccessRoots.ts`（新增）以 `ZCODE_FILE_ACCESS_ROOTS` 环境变量约束 file/git/terminal 服务的路径参数（含 symlink/junction 实路径解析）；未设置该变量时行为与上游完全一致（桌面/单用户形态零影响）。
4. **数据层**：任务索引 SQLite、会话快照、凭据库（AES-256-GCM）全部落在 `~/.zcode-cowork/users/<id>/home/.zcode/v2`。

### 目录布局

```
~/.zcode-cowork/
  gateway.sqlite          用户库（scrypt 密码哈希）
  jwt-secret              会话签名密钥（删除即全员登出）
  logs/gateway.log        网关日志
  logs/users/<id>.log     各 user-server 日志（5MB 轮转）
  users/<userId>/
    home/                 虚拟 HOME（.zcode/v2 全套数据）
    workspace/default/    默认工作区（Agent 的 cwd）
```

## 启动

前置（一次性构建）：

```bash
pnpm install
pnpm --filter @zcode/server exec tsup       # server bundle
pnpm --filter @zcode/cli... build           # agent bundle (dist/zcode.cjs)
pnpm --filter @zcode/web build              # web 前端产物
```

启动：

```bash
pnpm cowork            # 默认 http://127.0.0.1:8090
```

首次访问跳转 `/login`。**注册需要邀请码**：唯一一个 12 位数字/字母码，首次启动自动生成并持久化在 `~/.zcode-cowork/invite-code`（查看：`cat ~/.zcode-cowork/invite-code`；轮换：直接编辑该文件后重启网关；也可用环境变量 `COWORK_INVITE_CODE` 指定）。校验为恒定时间比较，错误统一返回"邀请码无效"。每个用户首次进入走 ZCode 新手引导，在设置中连接自己的模型账号（Z.ai / BigModel / API Key）后即可创建任务与 Agent 会话。

环境变量（均可选）：`COWORK_GATEWAY_PORT`(8090)、`COWORK_GATEWAY_HOST`(127.0.0.1)、`COWORK_DATA_ROOT`(~/.zcode-cowork)、`COWORK_MAX_USERS`(50)、`COWORK_USER_SERVER_IDLE_MS`(30min 闲置回收)、`COWORK_SESSION_TTL_SECONDS`(7d)。

## 测试

```bash
pnpm cowork:test
```

- `test/e2e-isolation.mts` — 双租户 RPC 级数据隔离（10 项：含跨租户读、列宿主目录、读系统文件）
- `test/adv-security.mts` — 对抗性安全（19 项：JWT 伪造、路径绕过变种、symlink 逃逸、端口直连、无认证 WS、跨站 Origin、超大 body、file-preview 越权）
- `test/invite-code.mts` — 邀请码注册门槛（6 项：无码/错码/大小写/格式/对码/重复用户名）

当前结果：**35/35 PASS，0 LEAK**。

## Web 端 Side Pane 与本地产物预览

- **文件/图片/PDF/diff 预览、Git 审查、终端、子代理、工作流面板**：Web 端原生可用（走 file/git/terminal RPC），命令面板（Ctrl+K）里"切换终端"等命令即入口。
- **本地产物预览**：Agent 生成的 HTML/图片等 `file://` 资产在浏览器里无法直接打开。server 新增 `GET /api/file-preview?path=...`：token 鉴权 + 路径白名单 + mime 白名单 + 20MB 上限；响应带 `Content-Security-Policy: sandbox allow-scripts ...`，预览内容运行在 opaque origin，无法读取平台会话 Cookie/Storage 或发起同源特权请求。前端 `useAppPanels` 在无内嵌浏览器能力的环境下把 `file://` 自动重写到该端点。
- **嵌入式浏览器预览**（Agent 受控 webview）：依赖 Electron `<webview>` + 主进程 CDP，Web 形态暂不可用（入口已隐藏、agent 侧优雅降级为 `backend_unavailable`）。服务化路径见上游 `browserControlExecutor` 注入点。

## 安全边界与已知限制（必读）

- **本地访问定位**：网关默认仅监听回环地址；对外部署前需叠加 HTTPS 反代、传输安全与更严格的限流，并重新评估全部边界。
- **Shell 边界**：路径白名单约束了 RPC 服务面的文件访问；但 Agent 的 Bash 工具与终端会话在 user-server 进程内以宿主操作系统用户身份执行，`cd` 等命令在白名单之外仍以宿主用户权限运行（上游 NOTICE 同样声明不提供 OS 级沙箱）。**多租户硬隔离的终态方案是容器化（每用户 Docker 容器）**：本包的 `UserServerManager` 是唯一 spawn 收口，替换为 `docker run`（预烘焙镜像 + `--cap-drop=ALL` + 资源限额）即可升级，网关其余层零改动。
- **TOCTOU 残余窗口**：路径白名单校验与实际 IO 之间存在竞态窗口（本地单机威胁模型下可接受）。
- **会话吊销**：JWT 无状态，登出仅清 Cookie；需要立即全员吊销时删除 `jwt-secret` 文件并重启网关。
- **限流为内存态**：网关重启清零；多实例部署时需外置共享限流。

## 对上游的修改点

| 文件 | 修改 |
| --- | --- |
| `packages/services/src/fileAccessRoots.ts` | 新增：路径白名单守卫 + 服务 Proxy 包装 |
| `packages/services/src/file/fileService.ts` | 返回值经 `guardServicePathParams` 包装（fields: path/rootPath/paths） |
| `packages/services/src/git/gitService.ts` | 同上（fields: workspacePath） |
| `packages/services/src/terminal/terminalService.ts` | 同上（fields: cwd） |
| `package.json` | 新增 `cowork` / `cowork:test` 脚本 |
| `packages/cowork-gateway/`（本包） | 全部新增 |

未设置 `ZCODE_FILE_ACCESS_ROOTS` 时三个服务的包装为直通，上游桌面/CLI/Web 形态行为不变。
