/** 登录/注册页：自包含 HTML，无外部资源依赖，经网关内联返回。 */
export function renderLoginPage(options: { mode?: "login" | "register" } = {}): string {
  const initialMode = options.mode === "register" ? "register" : "login";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>ZCode Cowork - 登录</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #101014;
    --card: #17171c;
    --border: #2a2a33;
    --text: #ececf1;
    --muted: #9b9ba6;
    --brand: #4f6ef7;
    --brand-hover: #6b85f9;
    --danger: #f66151;
    --ok: #3fb950;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card {
    width: 100%;
    max-width: 380px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 32px;
  }
  .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .logo-mark {
    width: 34px; height: 34px; border-radius: 9px;
    background: linear-gradient(135deg, #4f6ef7, #8b5cf6);
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 15px; color: #fff;
  }
  .logo-name { font-size: 17px; font-weight: 600; }
  .tagline { color: var(--muted); font-size: 13px; margin-bottom: 26px; }
  .tabs { display: flex; gap: 4px; background: #0d0d11; border-radius: 10px; padding: 4px; margin-bottom: 22px; }
  .tab {
    flex: 1; text-align: center; padding: 8px 0; border-radius: 8px;
    font-size: 13px; color: var(--muted); cursor: pointer; user-select: none;
    transition: all .15s;
  }
  .tab.active { background: #23232b; color: var(--text); font-weight: 500; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .field input {
    width: 100%; padding: 10px 12px; border-radius: 9px;
    border: 1px solid var(--border); background: #0d0d11; color: var(--text);
    font-size: 14px; outline: none; transition: border-color .15s;
  }
  .field input:focus { border-color: var(--brand); }
  .field input::placeholder { color: #5a5a66; }
  .submit {
    width: 100%; margin-top: 8px; padding: 11px 0; border: none; border-radius: 9px;
    background: var(--brand); color: #fff; font-size: 14px; font-weight: 500;
    cursor: pointer; transition: background .15s;
  }
  .submit:hover:not(:disabled) { background: var(--brand-hover); }
  .submit:disabled { opacity: .55; cursor: not-allowed; }
  .message { min-height: 20px; font-size: 12.5px; margin-top: 12px; text-align: center; }
  .message.error { color: var(--danger); }
  .message.ok { color: var(--ok); }
  .hint { margin-top: 18px; font-size: 11.5px; color: #5a5a66; text-align: center; line-height: 1.6; }
</style>
</head>
<body>
  <main class="card">
    <div class="logo"><div class="logo-mark">Z</div><div class="logo-name">ZCode Cowork</div></div>
    <p class="tagline">多用户隔离的 AI 编程工作台</p>
    <div class="tabs">
      <div class="tab active" id="tab-login" onclick="switchMode('login')">登录</div>
      <div class="tab" id="tab-register" onclick="switchMode('register')">注册</div>
    </div>
    <form id="auth-form" onsubmit="return submitForm(event)">
      <div class="field" id="field-invite" style="display:none">
        <label for="inviteCode">邀请码</label>
        <input id="inviteCode" name="inviteCode" type="text" maxlength="12" autocomplete="off" placeholder="12 位数字或字母" />
      </div>
      <div class="field" id="field-display" style="display:none">
        <label for="displayName">显示名称（可选）</label>
        <input id="displayName" name="displayName" type="text" maxlength="64" autocomplete="nickname" placeholder="怎么称呼你" />
      </div>
      <div class="field">
        <label for="username">用户名</label>
        <input id="username" name="username" type="text" required maxlength="32" autocomplete="username" placeholder="字母、数字、下划线或短横线" />
      </div>
      <div class="field">
        <label for="password">密码</label>
        <input id="password" name="password" type="password" required minlength="8" maxlength="256" autocomplete="current-password" placeholder="至少 8 个字符" />
      </div>
      <button class="submit" id="submit-btn" type="submit">登 录</button>
      <div class="message" id="message"></div>
    </form>
    <p class="hint">每个账户拥有独立的工作区与数据目录<br/>仅限本机访问 · 会话由 HttpOnly Cookie 保持</p>
  </main>
<script>
  var mode = "${initialMode}";
  switchMode(mode);
  function switchMode(next) {
    mode = next;
    document.getElementById("tab-login").className = "tab" + (next === "login" ? " active" : "");
    document.getElementById("tab-register").className = "tab" + (next === "register" ? " active" : "");
    document.getElementById("field-invite").style.display = next === "register" ? "" : "none";
    document.getElementById("field-display").style.display = next === "register" ? "" : "none";
    document.getElementById("submit-btn").textContent = next === "login" ? "登 录" : "创建账户";
    setMessage("", "");
  }
  function setMessage(text, kind) {
    var el = document.getElementById("message");
    el.textContent = text;
    el.className = "message" + (kind ? " " + kind : "");
  }
  function submitForm(event) {
    event.preventDefault();
    var button = document.getElementById("submit-btn");
    var username = document.getElementById("username").value.trim();
    var password = document.getElementById("password").value;
    var displayName = document.getElementById("displayName").value.trim();
    var inviteCode = document.getElementById("inviteCode").value.trim();
    if (!username || !password) { setMessage("请输入用户名和密码", "error"); return false; }
    if (mode === "register" && !inviteCode) { setMessage("请输入邀请码", "error"); return false; }
    button.disabled = true;
    setMessage(mode === "login" ? "正在登录…" : "正在创建账户…", "");
    fetch("/auth/" + mode, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: username, password: password, displayName: displayName, inviteCode: inviteCode })
    }).then(function (response) {
      return response.json().then(function (data) { return { status: response.status, data: data }; });
    }).then(function (result) {
      if (result.status >= 200 && result.status < 300 && result.data && result.data.ok) {
        setMessage("成功，正在进入工作台…", "ok");
        window.location.href = "/";
        return;
      }
      setMessage((result.data && result.data.error) || "请求失败，请稍后重试", "error");
      button.disabled = false;
    }).catch(function () {
      setMessage("网络错误，请稍后重试", "error");
      button.disabled = false;
    });
    return false;
  }
</script>
</body>
</html>`;
}
