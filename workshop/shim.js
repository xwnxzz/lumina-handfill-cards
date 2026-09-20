/* ============================================================================
 * Lumina Studio 创意工坊 · 宿主适配层（构建时内联进 ui/index.html）
 * ----------------------------------------------------------------------------
 * 作用：让同一个 HTML 在两种环境里都能用 ——
 *   (A) 独立浏览器直接打开：行为与原来完全一致（不触发任何宿主逻辑）
 *   (B) Lumina Studio 创意工坊的沙箱 iframe 里：走公开的 Workshop 协议
 *
 * 协议依据：官方公开仓库 lumina-layer-studio/Lumina-Workshop-SDK 的
 *   src/contracts.ts 与 docs/module-development.md，并对照真实宿主（Lumina 2.0
 *   前端 bundle）的实际实现校正过下列细节：
 *     - 宿主在 iframe onLoad 时才「武装」握手（此前收到的 ready 一律忽略）
 *       => 本模块必须【周期性重发 ready】，只发一次会超时失败
 *     - 转交的 MessagePort 在 MessageEvent.ports 上，不在 event.data.ports 上
 *       （官方 SDK 用 event.ports[0]）
 *     - 宿主校验 apiVersion === "1.0.0"；忽略未知事件名
 *     - 宿主发布的主题令牌只有：--lumina-surface / --lumina-surface-muted /
 *       --lumina-text / --lumina-text-muted / --lumina-accent / --lumina-border
 *     - iframe 为 sandbox="allow-scripts"（不透明源，localStorage 会抛错）
 *       CSP 为 default-src 'none' + script-src/style-src 'unsafe-inline'
 *       + img-src data: blob:（所以不能有任何外部资源）
 *
 * 本文件是【按公开协议自行实现】的最小客户端，**没有复制 SDK 源码**
 * （官方 SDK 为 GPL-3.0-or-later，复制会让本模块感染 GPL）。
 * ========================================================================== */
(function () {
  "use strict";

  var MODULE_ID = "__MODULE_ID__";
  var MODULE_VERSION = "__MODULE_VERSION__";
  var API_VERSION = "1.0.0";

  // 官方默认超时（毫秒）
  var T_REQ = 30000, T_HANDOFF = 120000, T_PICK = 300000;
  var READY_RETRY_MS = 800, READY_RETRY_MAX = 25;   // 覆盖宿主 onLoad 前的忽略窗口

  var maybeHost = (window.parent && window.parent !== window);
  var bridge = {
    inHost: false,
    client: null,
    state: { locale: "zh-CN", theme: "light", tokens: {} },
    readySent: 0,
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
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          delete pending[requestId];
          var e = new Error("请求超时：" + method);
          e.code = "REQUEST_TIMEOUT";
          e.retryable = true;
          reject(e);
        }, opts.timeoutMs || T_REQ);
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
          return call("image.pick", payload || {}, { transfer: transfer, timeoutMs: T_PICK });
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
  // 宿主实际只发布这 6 个颜色令牌（名字已对照真实前端 bundle 核实），
  // 逐个映射到本工具自己的 CSS 变量。
  var TOKEN_MAP = {
    "--lumina-surface":       ["--surface-card", "--panel", "--field"],
    "--lumina-surface-muted": ["--surface-well", "--panel2", "--bg", "--header-bg"],
    "--lumina-text":          ["--tx"],
    "--lumina-text-muted":    ["--surface-text-muted", "--tx2"],
    "--lumina-accent":        ["--acc", "--acc2"],
    "--lumina-border":        ["--line", "--surface-card-outline"],
  };
  function applyUiState(state) {
    if (!state || typeof state !== "object") return;
    bridge.state = state;
    var root = document.documentElement;
    if (state.locale) root.lang = state.locale;
    if (state.theme) root.dataset.theme = state.theme;
    if (state.theme === "dark") root.classList.add("dark");
    else if (state.theme === "light") root.classList.remove("dark");
    var tokens = state.tokens || {};
    Object.keys(tokens).forEach(function (name) {
      if (!/^--lumina-[a-z0-9-]+$/.test(name)) return;   // 官方要求：非法令牌忽略
      var v = tokens[name];
      if (typeof v !== "string") return;
      root.style.setProperty(name, v);
      (TOKEN_MAP[name] || []).forEach(function (t) { root.style.setProperty(t, v); });
    });
    hideOwnThemeButton();     // 主题交给 Lumina，隐藏工具自带的切换按钮
  }

  /* -------------------------------------------------------------- 握手 */
  var retryTimer = null, retryCount = 0;

  function sendReady() {
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
      bridge.readySent++;
    } catch (e) {
      bridge.handshake = "send-failed";
    }
  }

  function onConnect(ev) {
    // 宿主从父窗口发来；嵌套场景下也可能是顶层窗口
    if (ev.source !== window.parent && ev.source !== window.top) return;
    var d = ev.data;
    if (!d || d.type !== "lumina.workshop.connect") return;
    // ★ 转交的端口在 ev.ports 上（官方 SDK 用 event.ports[0]）；
    //   早期版本误写成 ev.data.ports，导致 connect 被丢弃、永远停在「等待模块就绪」。
    var port = (ev.ports && ev.ports.length) ? ev.ports[0]
             : (d.ports && d.ports.length) ? d.ports[0] : null;
    if (!port) return;
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    window.removeEventListener("message", onConnect);
    bridge.inHost = true;
    bridge.handshake = "connected";
    bridge.client = makeClient(d.sessionId, port);
    startHostMode();
  }
  window.addEventListener("message", onConnect);

  // 宿主在 iframe onLoad 之前会忽略 ready，所以周期重发，直到连上为止
  sendReady();
  retryTimer = setInterval(function () {
    if (bridge.inHost || ++retryCount > READY_RETRY_MAX) {
      clearInterval(retryTimer); retryTimer = null;
      return;
    }
    sendReady();
  }, READY_RETRY_MS);

  /* -------------------------------------------------------- 宿主模式装配 */
  // 同步导出 PNG。刻意【不用】canvas.toBlob：它的回调在沙箱上下文里有可能一直不触发，
  // 而这条路径原先没有任何超时 —— 真机上就表现为按钮永远停在「交接中…」。
  // toDataURL 是同步的，不存在悬挂路径。
  function canvasToPng(canvas) {
    try {
      if (!canvas || !canvas.width || !canvas.height) throw new Error("画布为空");
      var url = canvas.toDataURL("image/png");
      var comma = url.indexOf(",");
      if (comma < 0) throw new Error("不是 data URL");
      var bin = atob(url.slice(comma + 1));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (bytes.length < 24) throw new Error("PNG 太短");
      return Promise.resolve(bytes.buffer);
    } catch (e) {
      return Promise.reject(new Error("导出 PNG 失败：" + firstError(e)));
    }
  }

  function firstError(e) {
    // 官方要求：用户可见消息不得含堆栈/路径/令牌
    var msg = (e && e.message) || "未知错误";
    return String(msg).replace(/[\r\n]+/g, " ").slice(0, 200);
  }

  function startHostMode() {
    if (bridge.client.ui && bridge.client.ui.getState) {
      bridge.client.ui.getState().then(function (s) { applyUiState(s); }, function () {});
    }
    // 官方：握手完成后模块必须主动报就绪，宿主才会把状态切到「运行中」
    bridge.client.ready().catch(function () {});
    hideOwnThemeButton();
    injectHostUi();
  }

  // 主题由 Lumina 控制：宿主里隐藏工具自带的「浅色/深色」按钮
  function hideOwnThemeButton() {
    var b = document.getElementById("themeBtn");
    if (b) b.style.display = "none";
  }

  // 交接永不悬挂：无论卡在哪一步，45 秒内一定会给出结论。
  // （宿主自身对 handoff 的超时是 120 秒；我们提前失败，是为了让用户看到明确原因。）
  var HANDOFF_HARD_TIMEOUT_MS = 45000;
  bridge.handoffTimeoutMs = HANDOFF_HARD_TIMEOUT_MS;   // 可覆盖（测试用）
  function handoffCanvas(canvas, meta) {
    var client = bridge.client;
    if (!client) return Promise.reject(new Error("不在 Lumina 宿主中"));
    var work = handoffOnce(canvas, meta);
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        var e = new Error("Lumina 在 " + Math.round(bridge.handoffTimeoutMs / 1000) +
                          " 秒内没有回应（PNG 已发出，方法 handoff.image）");
        e.code = "CLIENT_HANDOFF_TIMEOUT";
        reject(e);
      }, bridge.handoffTimeoutMs);
      work.then(function (r) { if (!done) { done = true; clearTimeout(timer); resolve(r); } },
                function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
  }

  function handoffOnce(canvas, meta) {
    var client = bridge.client;
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
      // 宿主对 layout 的校验是【精确相等】（容差 1e-6）：
      //     recommendedWidthMm === columns × pitchMm
      //     recommendedHeightMm === rows × pitchMm
      // 而本工具的板面图带边距（梯度卡两侧各 1mm、校准板四周各 5mm），
      // 天生不满足该规则。layout 是可选字段，省略即跳过校验；
      // 宿主也没有把 layout 传给转换器（只传 targetWidthMm/HeightMm）。
      // 这里加守卫：只有真满足规则时才带上，绝不谎报尺寸去凑。
      var L = meta.layout;
      if (L && typeof L.columns === "number" && typeof L.rows === "number" &&
          typeof L.pitchMm === "number" &&
          Math.abs(L.columns * L.pitchMm - meta.widthMm) < 1e-6 &&
          Math.abs(L.rows * L.pitchMm - meta.heightMm) < 1e-6) {
        payload.layout = L;
      }
      return client.handoff.image(payload, [buf]);
    });
  }
  bridge.handoffCanvas = handoffCanvas;
  bridge.canvasToPng = canvasToPng;

  /* ------------------------------------------------- 宿主内的工具条与提示 */
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text) n.textContent = text;
    return n;
  }

  // 宿主里【无法导出文件】：CSP 是 default-src 'none'，下载也会被桌面沙箱拦截，
  // 而创意工坊 API 里没有「保存文本/二进制文件」这一项。
  // 导入不受影响（本地文件读取），所以只隐藏导出类按钮，保留导入。
  var EXPORT_BUTTON_IDS = [
    "csvOut", "expBoth", "expWhite", "expBlack",
    "calCsvOutOne", "calCsvOutAll", "calExpOne", "calExpAll",
  ];
  function hideBlockedExports() {
    for (var i = 0; i < EXPORT_BUTTON_IDS.length; i++) {
      var b = document.getElementById(EXPORT_BUTTON_IDS[i]);
      if (b) b.style.display = "none";
    }
    if (document.getElementById("lfExportNote")) return;
    var host = document.getElementById("csvOut");
    var anchor = (host && host.parentNode) || document.body;
    var note = el("div", {
      id: "lfExportNote",
      style:
        "margin:8px 0 0;padding:8px 10px;border-radius:8px;font:12px/1.6 system-ui,sans-serif;" +
        "background:var(--lumina-surface-muted,#f5f5f7);color:var(--lumina-text-muted,#6e6e73);" +
        "border:1px solid var(--lumina-border,#e2e8f0)",
    }, "在 Lumina 里不能导出文件（沙箱禁止下载）。"
      + "手填的数据会自动保存在本模块的工程里；"
      + "需要导出 CSV 或耗材档案 ZIP 时，请用独立版 lumina_singlestage_gui.html。");
    anchor.appendChild(note);
  }

  function injectHostUi() {
    if (document.getElementById("lfHostBar")) return;
    hideBlockedExports();
    var bar = el("div", {
      id: "lfHostBar",
      style:
        "position:fixed;right:14px;bottom:14px;z-index:9999;max-width:min(420px,92vw);" +
        "display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;" +
        "font:12px/1.5 system-ui,sans-serif;" +
        "background:var(--lumina-surface,#fff);color:var(--lumina-text,#0f172a);" +
        "border:1px solid var(--lumina-border,#e2e8f0);box-shadow:0 6px 24px rgba(15,23,42,.18)",
    });
    var title = el("div", { style: "font-weight:600" }, "交给 Lumina");
    bar.appendChild(title);

    var row = el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" });
    var btnStyle =
      "padding:5px 9px;border-radius:7px;border:1px solid var(--lumina-border,#cbd5e1);" +
      "background:var(--lumina-accent,#0071e3);color:#fff;cursor:pointer;font:inherit";
    var msg = el("div", { style: "min-height:1.4em;opacity:.85" }, "选择要交给 Lumina 的板面图");

    var targets = [
      { label: "白底板", canvasId: "prevWhite", sub: "white" },
      { label: "黑底板", canvasId: "prevBlack", sub: "black" },
      { label: "校准板当前页", canvasId: "prevCal", sub: "cal" },
    ];
    var tick = null;
    var allBtns = [];          // 直接持有引用，不依赖 childNodes 反查
    targets.forEach(function (tg) {
      var b = el("button", { type: "button", style: btnStyle }, tg.label);
      allBtns.push(b);
      b.addEventListener("click", function () {
        var target = boardFor(tg.sub);
        if (!target || !target.canvas || !target.canvas.width) {
          msg.textContent = tg.label + "还没有内容";
          return;
        }
        disableAll(true);
        var t0 = Date.now();
        if (tick) clearInterval(tick);
        msg.textContent = "交接中… 0s";
        tick = setInterval(function () {
          var s = Math.round((Date.now() - t0) / 1000);
          msg.textContent = (s < 3 ? "交接中… " : "已发送，等待 Lumina 处理… ") + s + "s";
        }, 500);
        handoffCanvas(target.canvas, target.meta).then(
          function (res) {
            disableAll(false);
            if (tick) { clearInterval(tick); tick = null; }
            msg.textContent = (res && res.status === "needs-confirmation")
              ? tg.label + "：已在 Lumina 打开替换确认"
              : tg.label + " 已交给 Lumina ✓";
          },
          function (e) {
            disableAll(false);
            if (tick) { clearInterval(tick); tick = null; }
            msg.textContent = "失败：" + firstError(e) + ((e && e.code) ? "（" + e.code + "）" : "");
            try {
              if (bridge.client && bridge.client.status) {
                bridge.client.status.error({
                  code: (e && e.code) || "handoff-failed",
                  message: firstError(e),
                  retryable: false,
                }).catch(function () {});
              }
            } catch (e2) {}
          }
        );
      });
      row.appendChild(b);
    });
    function disableAll(on) { allBtns.forEach(function (b) { b.disabled = on; }); }

    bar.appendChild(row);
    bar.appendChild(msg);
    var hint = el("div", { style: "opacity:.7" },
      "在 Lumina 里用「耗材管理 → 梯度卡提取」读取这两张板面图，即可得到你手填的数值。"
      + "若要导出 CSV / 耗材档案 ZIP，请用独立版。");
    bar.appendChild(hint);
    document.body.appendChild(bar);
  }

  // 按用途取画布：白底板 / 黑底板 / 校准板当前页
  function boardFor(which) {
    if (which === "cal") {
      var cal = document.getElementById("prevCal");
      if (!cal || !cal.width) return null;
      var mode = null, pdef = null;
      try { mode = calMode(); pdef = calPageDef(); } catch (e) { return null; }
      if (!mode || !pdef) return null;
      var total = pdef.data + 2 * pdef.pad;
      var sideMm = 2 * CAL_MARGIN_MM + total * mode.block + (total - 1) * mode.gap;
      return {
        canvas: cal,
        meta: {
          projectId: "cal-" + mode.key + "-" + ((typeof cal !== "undefined" ? 0 : 0)),
          widthMm: sideMm, heightMm: sideMm,
        },
      };
    }
    var c = document.getElementById(which === "black" ? "prevBlack" : "prevWhite");
    if (!c || !c.width) return null;
    return {
      canvas: c,
      meta: {
        projectId: "gradient-" + which,
        widthMm: 67, heightMm: 34,
        totalThicknessMm: 1.0 + 25 * 0.08,
      },
    };
  }

  // 当前该交接哪张图：按工具当前的模式与页面决定。
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
          // 同梯度卡：带 5mm 边距，不满足宿主的 layout 自洽规则，故不给。
        },
      };
    }
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
        // 刻意不给 layout：宿主要求画布尺寸 === 行列 × 节距（精确相等），
        // 而本板面带 1mm 边距（67 x 34 已是官方实测值），不满足该规则。
      },
    };
  }
})();
