/**
 * 内嵌的手机网页聊天端（QR 扫码频道的落地页），由 daemon 的 LAN HTTP 服务
 * 直接下发——零外部资源、随 doge.exe 走。页面从 URL hash 读取访问令牌
 * （#t=xxx，hash 不发往服务器），经同源 WS 与 daemon 通信：
 *   页面 → daemon：{t:'hello', clientId} / {t:'msg', text}
 *   daemon → 页面：{t:'im', text, options?:[{label,data}]}
 * 按钮点击映射回等价指令文本（/allow、/deny、/skip、/1…），与 IM 指令同源。
 *
 * 注意：本文件是 TS 模板字符串包 HTML——页面内 JS 一律用字符串拼接，
 * 禁用反引号与 ${}，避免与外层模板冲突。
 */
export const WEB_CHAT_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<meta name="theme-color" content="#16181d">
<title>Doge Code 远程控制</title>
<style>
  :root {
    --bg: #101216; --panel: #171a20; --card: #1d2129; --line: #2a2f39;
    --text: #e8eaf0; --dim: #9aa3b2; --accent: #d9a441; --accent2: #e8b45a;
    --me: #3a3320; --me-text: #f0dcae; --ok: #4caf7d; --err: #e06c5f;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--text);
    font: 15px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    display: flex; flex-direction: column; overscroll-behavior: none;
  }
  header {
    position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; background: var(--panel); border-bottom: 1px solid var(--line);
  }
  header .logo { font-size: 22px; }
  header .title { font-weight: 600; font-size: 15px; }
  header .sub { font-size: 11px; color: var(--dim); margin-top: 1px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--err); margin-left: auto; flex: none; }
  .dot.on { background: var(--ok); }
  .dot::after { content: ""; }
  #log { flex: 1; overflow-y: auto; padding: 16px 12px 8px; scroll-behavior: smooth; }
  .row { display: flex; margin: 6px 0; align-items: flex-end; gap: 8px; }
  .row.me { justify-content: flex-end; }
  .bubble {
    max-width: 82%; padding: 9px 12px; border-radius: 14px; white-space: pre-wrap;
    word-break: break-word; background: var(--card); border: 1px solid var(--line);
    border-bottom-left-radius: 5px; font-size: 14.5px;
  }
  .row.me .bubble { background: var(--me); color: var(--me-text); border-color: #4d4322; border-bottom-left-radius: 14px; border-bottom-right-radius: 5px; }
  .bubble.sys { background: transparent; border: none; color: var(--dim); font-size: 12px; max-width: 100%; text-align: center; margin: 0 auto; padding: 2px 8px; }
  .opts { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 12px 8px; }
  .opts button {
    background: var(--card); color: var(--accent2); border: 1px solid #514421;
    padding: 9px 14px; border-radius: 12px; font-size: 14px; cursor: pointer;
  }
  .opts button:active { background: #2a2415; }
  footer { position: sticky; bottom: 0; display: flex; gap: 8px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); background: var(--panel); border-top: 1px solid var(--line); }
  #input {
    flex: 1; background: var(--card); color: var(--text); border: 1px solid var(--line);
    border-radius: 12px; padding: 10px 12px; font: inherit; outline: none; resize: none;
  }
  #send {
    flex: none; background: var(--accent); color: #201a08; border: none; border-radius: 12px;
    padding: 0 18px; font-size: 15px; font-weight: 600; cursor: pointer;
  }
  #send:disabled { opacity: 0.4; }
  #gate { position: fixed; inset: 0; background: var(--bg); z-index: 20; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 32px; text-align: center; }
  #gate.hidden { display: none; }
  #gate .big { font-size: 40px; }
  #gate h2 { margin: 0; font-size: 17px; }
  #gate p { margin: 0; color: var(--dim); font-size: 13px; }
</style>
</head>
<body>
<div id="gate">
  <div class="big">📶</div>
  <h2 id="gateTitle">正在连接…</h2>
  <p id="gateText">正在连接你电脑上的 Doge Code</p>
</div>
<header>
  <span class="logo">🐶</span>
  <div>
    <div class="title">Doge Code 远程控制</div>
    <div class="sub" id="sub">未连接</div>
  </div>
  <span class="dot" id="dot"></span>
</header>
<div id="log"></div>
<div class="opts" id="opts"></div>
<footer>
  <textarea id="input" rows="1" placeholder="发消息驱动你电脑上的会话…"></textarea>
  <button id="send">发送</button>
</footer>
<script>
(function () {
  'use strict';
  var log = document.getElementById('log');
  var optsBox = document.getElementById('opts');
  var input = document.getElementById('input');
  var sendBtn = document.getElementById('send');
  var dot = document.getElementById('dot');
  var sub = document.getElementById('sub');
  var gate = document.getElementById('gate');
  var gateTitle = document.getElementById('gateTitle');
  var gateText = document.getElementById('gateText');
  var ws = null;
  var retryTimer = null;

  var token = '';
  var m = location.hash.match(/[#&]t=([A-Za-z0-9_-]+)/);
  if (m) token = m[1];
  var clientId = '';
  try {
    clientId = localStorage.getItem('dgw_client') || '';
    if (!clientId) {
      clientId = 'web-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('dgw_client', clientId);
    }
  } catch (e) { clientId = 'web-anon'; }

  function add(cls, text) {
    var row = document.createElement('div');
    row.className = 'row ' + cls;
    var b = document.createElement('div');
    b.className = 'bubble' + (cls === 'sys' ? ' sys' : '');
    b.textContent = text;
    row.appendChild(b);
    log.appendChild(row);
    // 长会话滚动裁剪：无上限增长会把低端手机内存吃穿
    while (log.children.length > 300) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }
  function showOptions(options) {
    optsBox.innerHTML = '';
    for (var i = 0; i < options.length; i++) {
      (function (opt) {
        var btn = document.createElement('button');
        btn.textContent = opt.label;
        btn.onclick = function () {
          var cmd = opt.data.indexOf('pick:') === 0 ? '/' + opt.data.slice(5) : '/' + opt.data;
          sendText(cmd);
        };
        optsBox.appendChild(btn);
      })(options[i]);
    }
  }
  function setConnected(on, note) {
    dot.className = 'dot' + (on ? ' on' : '');
    sub.textContent = note || (on ? '已连接 · Auto 模式' : '未连接');
    sendBtn.disabled = !on;
    if (on) { gate.className = 'hidden'; }
  }
  function connect() {
    if (!token) {
      gateTitle.textContent = '链接无效';
      gateText.textContent = '请从桌面端「设置 → 远程控制」重新扫码进入。';
      return;
    }
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    try {
      ws = new WebSocket(proto + location.host + '/?token=' + encodeURIComponent(token));
    } catch (e) { scheduleRetry(); return; }
    ws.onopen = function () {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      ws.send(JSON.stringify({ t: 'hello', clientId: clientId }));
      setConnected(true);
    };
    ws.onmessage = function (ev) {
      var f = null;
      try { f = JSON.parse(ev.data); } catch (e) { return; }
      if (f.t === 'im') {
        add('', String(f.text || ''));
        if (f.options && f.options.length) showOptions(f.options);
        else optsBox.innerHTML = '';
      }
    };
    ws.onclose = function () {
      ws = null;
      setConnected(false, '连接已断开，正在重连…');
      scheduleRetry();
    };
    ws.onerror = function () {};
  }
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () { retryTimer = null; connect(); }, 3000);
  }
  function sendText(text) {
    text = String(text || '').trim();
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ t: 'msg', text: text }));
    add('me', text);
    optsBox.innerHTML = '';
    input.value = '';
  }
  sendBtn.onclick = function () { sendText(input.value); };
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(input.value); }
  });
  // 30s 心跳：daemon 侧 WS idleTimeout 120s，静置会掐线——心跳帧服务端
  // 忽略即可，只为保活。
  setInterval(function () {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping' }));
  }, 30000);
  add('sys', '扫码成功即视为已授权——发出的消息会直接驱动你电脑上的 Doge Code 会话（Auto 模式）。输入 /help 查看指令。');
  connect();
})();
</script>
</body>
</html>
`
