/* ============================================================================
 * Lumina Studio 创意工坊 · 宿主适配层（构建时内联进 ui/index.html）
 * ----------------------------------------------------------------------------
 * 作用：让同一个 HTML 在两种环境里都能用 ——
 *   (A) 独立浏览器直接打开：行为与原来完全一致（不触发任何宿主逻辑）
 *   (B) Lumina Studio 创意工坊的沙箱 iframe 里：走公开的 Workshop 协议
 *
 * 协议依据：官方公开仓库 lumina-layer-studio/Lumina-Workshop-SDK 的
 *   src/contracts.ts（类型契约）与 docs/module-development.md（开发指南）。
 *   本文件是【按公开协议自行实现】的最小客户端，**没有复制 SDK 源码**
 *   （官方 SDK 为 GPL-3.0-or-later，复制会让本模块感染 GPL）。
 *
 * 沙箱差异（官方指南明确）：
 *   - 模块运行在 sandbox="allow-scripts" 的 iframe 中 → localStorage 会抛 SecurityError
 *   - 宿主拦截网络、跳转、弹窗、下载 → 保存/导出必须走宿主 RPC
 *   因此：宿主内禁用本地下载路径，改用 handoff.image 与 project.storage。
 * ========================================================================== */
(function () {
  "use strict";

  var MODULE_ID = "__MODULE_ID__";
  var MODULE_VERSION = "__MODULE_VERSION__";
  var API_VERSION = "1.0.0";

  // 官方默认超时（毫秒）
  var T_HS = 10000, T_REQ = 30000, T_HANDOFF = 120000;

  // 独立浏览器：window.parent === window，直接什么都不做
  var maybeHost = (window.parent && window.parent !== window);
  var bridge = {
    inHost: false,
    client: null,
    state: { locale: "zh-CN", theme: "light", tokens: {} },
  };
  window.LuminaWorkshop = bridge;

  if (!maybeHost) return;

  /* ---------------------------------------------------------------- RPC 客户端 */
  function makeClient(sessionId, port) {
    var seq = 0;
    var pending = Object.create(null);
    var closed = false;

    port.addEventListener("message", function (ev) {
      var d = ev.data;
      if (!d || d.protocol !== "lumina-workshop-rpc" || d.version !== 1) return;
      if (d.kind === "event") {
        if (d.event === "ui.stateChanged") applyUiState(d.payload);
        return;
      }
      if (d.kind !== "response") return;
      var p = pending[d.requestId];
      if (!p) return;
      delete pending[d.requestId];
      clearTimeout(p.timer);
      if (d.ok) p.resolve(d.result);
      else {
        var err = d.error || {};
        var e = new Error(err.message || "请求失败");
        e.code = err.code || "UNKNOWN";
        e.retryable = !!err.retryable;
        p.reject(e);
      }
    });
    port.start && port.start();

    function call(method, payload, opts) {
      opts = opts || {};
      if (closed) return Promise.reject(new Error("连接已关闭"));
      var requestId = "req-" + (++seq);
      var timeoutMs = opts.timeoutMs || T_REQ;
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          delete pending[requestId];
          var e = new Error("请求超时：" + method);
          e.code = "REQUEST_TIMEOUT";
          e.retryable = true;
          reject(e);
        }, timeoutMs);
        pending[requestId] = { resolve: resolve, reject: reject, timer: timer };
        port.postMessage(
          {
            protocol: "lumina-workshop-rpc",
            version: 1,
            kind: "request",
            requestId: requestId,
            method: method,
            payload: payload === undefined ? {} : payload,
          },
          opts.transfer || []
        );
      });
    }

    return {
      sessionId: sessionId,
      call: call,
      ready: function () { return call("lifecycle.ready", {}); },
      image: {
        pick: function (payload, transfer) {
          return call("image.pick", payload || {}, { transfer: transfer, timeoutMs: 300000 });
        },
      },
      colorLibrary: { read: function () { return call("colorLibrary.read", {}); } },
      projects: {
        save: function (p) { return call("project.save", p); },
        load: function (p) { return call("project.load", p); },
        latest: function (p) { return call("project.latest", p || {}); },
        remove: function (p) { return call("project.remove", p); },
      },
      handoff: {
        image: function (payload, transfer) {
          return call("handoff.image", payload, { transfer: transfer, timeoutMs: T_HANDOFF });
        },
      },
      ui: { getState: function () { return call("ui.getState", {}); } },
      status: {
        progress: function (p) { return call("status.progress", p); },
        error: function (p) { return call("status.error", p); },
        diagnostics: function (p) { return call("status.diagnostics", p || {}); },
      },
    };
  }

  /* ------------------------------------------------------------ UI 状态应用 */
  // 官方 host 只推送 --lumina-* 令牌；这里把它映射到本工具自己的 CSS 变量。
  var TOKEN_MAP = {
    "--lumina-bg": "--bg",
    "--lumina-surface": "--panel",
    "--lumina-surface-well": "--panel2",
    "--lumina-line": "--line",
    "--lumina-text": "--tx",
    "--lumina-text-muted": "--tx2",
    "--lumina-accent": "--acc",
  };
  function applyUiState(state) {
    if (!state || typeof state !== "object") return;
    bridge.state = state;
    var root = document.documentElement;
    if (state.locale) root.lang = state.locale;
    if (state.theme) root.dataset.theme = state.theme;
    var tokens = state.tokens || {};
    Object.keys(tokens).forEach(function (name) {
      if (!/^--lumina-[a-z0-9-]+$/.test(name)) return;
      root.style.setProperty(name, tokens[name]);
      var mapped = TOKEN_MAP[name];
      if (mapped) root.style.setProperty(mapped, tokens[name]);
    });
    // 宿主深色主题 → 本工具用 .dark 类
    if (state.theme === "dark") root.classList.add("dark");
    else if (state.theme === "light") root.classList.remove("dark");
  }

  /* -------------------------------------------------------------- 握手 */
  var hsTimer = setTimeout(function () {
    bridge.handshake = "timeout";
    window.removeEventListener("message", onConnect);
  }, T_HS);

  function onConnect(ev) {
    if (ev.source !== window.parent) return;
    var d = ev.data;
    if (!d || d.type !== "lumina.workshop.connect") return;
    if (!d.ports || !d.ports[0]) return;
    clearTimeout(hsTimer);
    window.removeEventListener("message", onConnect);
    bridge.inHost = true;
    bridge.handshake = "connected";
    bridge.client = makeClient(d.sessionId, d.ports[0]);
    startHostMode();
  }
  window.addEventListener("message", onConnect);
  try {
    window.parent.postMessage(
      {
        type: "lumina.workshop.ready",
        moduleId: MODULE_ID,
        moduleVersion: MODULE_VERSION,
        apiVersion: API_VERSION,
        events: ["ui.stateChanged"],
      },
      "*"
    );
  } catch (e) {
    bridge.handshake = "send-failed";
  }

  /* -------------------------------------------------------- 宿主模式装配 */
  function canvasToPng(canvas) {
    return new Promise(function (resolve, reject) {
      if (!canvas || !canvas.toBlob) return reject(new Error("画布不可用"));
      canvas.toBlob(function (blob) {
        if (!blob) return reject(new Error("导出 PNG 失败"));
        blob.arrayBuffer().then(resolve, reject);
      }, "image/png");
    });
  }

  function firstError(e) {
    var msg = (e && e.message) || "未知错误";
    // 官方要求：用户可见消息不得含堆栈/路径/令牌
    return String(msg).replace(/[\r\n]+/g, " ").slice(0, 200);
  }

  // 官方握手成功后由模块主动报告就绪
  function startHostMode() {
    bridge.client.ui &&
      bridge.client.ui.getState &&
      bridge.client.ui.getState().then(function (s) { applyUiState(s); }, function () {});
    bridge.client.ready().catch(function () {});
    injectHostUi();
  }

  // 板面图 → 交接给 Lumina。物理尺寸与网格节距都取自工具的实测规格。
  function handoffCanvas(canvas, meta) {
    var client = bridge.client;
    if (!client) return Promise.reject(new Error("不在 Lumina 宿主中"));
    return canvasToPng(canvas).then(function (buf) {
      var payload = {
        moduleId: MODULE_ID,
        moduleVersion: MODULE_VERSION,
        projectId: meta.projectId,
        pngBytes: buf,
        pixelWidth: canvas.width,
        pixelHeight: canvas.height,
        recommendedWidthMm: meta.widthMm,
        recommendedHeightMm: meta.heightMm,
        preserveCanvasBounds: true,
        layout: meta.layout,
        colorLibraryId: null,
        recipeSource: {
          manifestSchemaVersion: 1,
          moduleId: MODULE_ID,
          moduleVersion: MODULE_VERSION,
          projectSchemaVersion: "handfill-project/v1",
          renderSchemaVersion: "handfill-board/v1",
          payload: meta.recipe || {},
        },
      };
      if (meta.totalThicknessMm) payload.recommendedTotalThicknessMm = meta.totalThicknessMm;
      return client.handoff.image(payload, [buf]);
    });
  }
  bridge.handoffCanvas = handoffCanvas;
  bridge.canvasToPng = canvasToPng;

  /* ------------------------------------------------- 宿主内的工具条与提示 */
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "style") n.setAttribute("style", attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    if (text) n.textContent = text;
    return n;
  }

  function injectHostUi() {
    if (document.getElementById("lfHostBar")) return;
    var bar = el("div", {
      id: "lfHostBar",
      style:
        "position:fixed;right:14px;bottom:14px;z-index:9999;display:flex;gap:8px;align-items:center;" +
        "padding:8px 10px;border-radius:10px;font:12px/1.5 system-ui,sans-serif;" +
        "background:var(--lumina-surface,#fff);color:var(--lumina-text,#0f172a);" +
        "border:1px solid var(--lumina-line,#e2e8f0);box-shadow:0 6px 24px rgba(15,23,42,.18)",
    });
    bar.appendChild(el("span", { style: "opacity:.7" }, "Lumina 创意工坊"));

    var btn = el("button", {
      type: "button",
      style:
        "padding:5px 10px;border-radius:7px;border:1px solid var(--lumina-line,#cbd5e1);" +
        "background:var(--lumina-accent,#2563eb);color:#fff;cursor:pointer;font:inherit",
    }, "把当前板面图交给 Lumina");

    var msg = el("span", { style: "min-width:8em;opacity:.8" }, "");
    btn.addEventListener("click", function () {
      var target = pickCurrentBoard();
      if (!target) { msg.textContent = "没有可交接的板面图"; return; }
      btn.disabled = true;
      msg.textContent = "交接中…";
      handoffCanvas(target.canvas, target.meta).then(
        function (res) {
          btn.disabled = false;
          // 官方：转换器已有工作时第一次交接返回 needs-confirmation
          if (res && res.status === "needs-confirmation") {
            msg.textContent = "已在 Lumina 打开替换确认";
          } else {
            msg.textContent = "已交给 Lumina 转换 ✓";
          }
        },
        function (e) {
          btn.disabled = false;
          msg.textContent = "失败：" + firstError(e);
        }
      );
    });

    bar.appendChild(btn);
    bar.appendChild(msg);
    document.body.appendChild(bar);
  }

  // 当前该交接哪张图：按工具当前的模式与页面决定。
  // 几何全部取自工具自身的规格与官方公开代码，不在这里另设常数：
  //   梯度卡：67 x 34 mm，3 行 x 6 列，节距 11 mm（block 10 + gap 1）
  //   校准板：官方 calibration.py 中所有板都用 margin = 5.0、block = 5.0、gap = 0.8
  var CAL_MARGIN_MM = 5.0;
  function pickCurrentBoard() {
    var cal = document.getElementById("prevCal");
    var w = document.getElementById("prevWhite");
    var b = document.getElementById("prevBlack");
    var inCal = false, mode = null, pdef = null;
    try {
      inCal = (typeof uiMode !== "undefined" && uiMode === "cal");
      if (inCal) { mode = calMode(); pdef = calPageDef(); }
    } catch (e) { inCal = false; }
    if (inCal && cal && cal.width && mode && pdef) {
      var total = pdef.data + 2 * pdef.pad;
      var sideMm = 2 * CAL_MARGIN_MM + total * mode.block + (total - 1) * mode.gap;
      return {
        canvas: cal,
        meta: {
          projectId: "cal-" + mode.key + "-" + (typeof cal !== "undefined" && cal.page ? cal.page : 0),
          widthMm: sideMm,
          heightMm: sideMm,
          layout: {
            kind: "square-grid",
            rows: total,
            columns: total,
            pitchMm: mode.block + mode.gap,
          },
        },
      };
    }
    // 梯度卡：优先交接有数据的那块板；两块都有数据时先交白底板
    var pick = (w && w.width) ? w : ((b && b.width) ? b : null);
    if (!pick) return null;
    var sub = pick.id === "prevWhite" ? "white" : "black";
    return {
      canvas: pick,
      meta: {
        projectId: "gradient-" + sub,
        widthMm: 67,
        heightMm: 34,
        totalThicknessMm: 1.0 + 25 * 0.08,
        layout: { kind: "square-grid", rows: 3, columns: 6, pitchMm: 11 },
      },
    };
  }
})();
