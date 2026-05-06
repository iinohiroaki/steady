/* =============================================================
   STEADY v3.2.0r2  Phase 2 / B8  Beat Wheel
   - 8 patterns 習熟度の放射状チャート可視化（Stage 4+ 解禁）
   - BPM 連動でホイール回転速度可変
   - 軽量 render(canvas, opts) API も併設（spec 互換）

   公開 API:
     window.SteadyBeatWheel = {
       mount(rootEl, opts),     // フル UI（放射状チャート＋回転）を rootEl に組み立てる
       render(canvas, opts),    // p5-p8 仕様の軽量レンダリング（現在拍ハイライト）
       dispose()                // mount 後の状態を完全解放
     }

   実装方針:
     - Canvas 2D / devicePixelRatio スケーリング対応
     - 描画ループは requestAnimationFrame（dispose で停止）
     - localStorage `steady_phase1_progress_v3_2` から 8 patterns 進捗を読む
     - BPM は opts.bpm  または window.SteadyShared から取得を試行（取れなければ既定 90）
     - 外部 npm 依存なし、Vanilla JS
     - 既存 SteadyShared / SteadyWobble / steady-core.html を一切変更しない
   ============================================================= */

(function (global) {
  'use strict';

  // -------------------------------------------------------------
  // 0. 8 patterns 定義（steady-shared.js LS_V32.PHASE1_PROGRESS と整合）
  //    - key      : localStorage 内のキー（破壊厳禁）
  //    - label    : 放射軸ラベル（短縮表記・譜面記号 / 評価語 / 直接曲名 厳禁）
  //    - hue      : 軸色相 (HSL hue, 0-360)
  // -------------------------------------------------------------
  var PATTERN_AXES = [
    { key: 'sixstroke',     label: 'p1 Six Stroke',     hue:   8 },
    { key: 'sizzle_hat',    label: 'p2 Sizzle Hat',     hue:  44 },
    { key: 'halftime',      label: 'p3 Half Time',      hue:  88 },
    { key: 'fourbar_fills', label: 'p4 4-bar Fills',    hue: 132 },
    { key: 'octopus',       label: 'p5 Octopus',        hue: 176 },
    { key: 'crash4',        label: 'p6 Crash 4',        hue: 220 },
    { key: 'ride_bell',     label: 'p7 Ride Bell',      hue: 264 },
    { key: 'subtractive',   label: 'p8 Subtractive',    hue: 308 }
  ];

  var STAGE_GATE = 4; // Stage 4+ で解禁（spec §407: 「Stage 4+ で解禁（Stage 0-3 では非表示）」）
  var DEFAULT_BPM = 90;
  var MIN_BPM = 40;
  var MAX_BPM = 240;

  // -------------------------------------------------------------
  // 1. ユーティリティ
  // -------------------------------------------------------------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function isFiniteNum(n) { return typeof n === 'number' && isFinite(n); }

  function safeReadProgress() {
    // SteadyShared の lsGet があればそれを優先。なければ素の localStorage。
    try {
      var key = 'steady_phase1_progress_v3_2';
      var raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(key) : null;
      if (raw == null) return {};
      var obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (_) { return {}; }
  }

  function readQSkillStage() {
    // Stage 取得：QSKILL_RESULT_V32 優先、なければ QSKILL_RESULT、それでもなければ 0。
    try {
      var raw1 = (typeof localStorage !== 'undefined') ? localStorage.getItem('steady_qskill_v2_result_v3_2') : null;
      if (raw1) {
        var o1 = JSON.parse(raw1);
        if (o1 && isFiniteNum(o1.stage)) return o1.stage;
      }
      var raw2 = (typeof localStorage !== 'undefined') ? localStorage.getItem('steady_qskill_v2_result') : null;
      if (raw2) {
        var o2 = JSON.parse(raw2);
        if (o2 && isFiniteNum(o2.stage)) return o2.stage;
      }
    } catch (_) {}
    return 0;
  }

  // 進捗値を 0-1 に正規化（既存 progress 値が 0-100 / 0-1 / カウントいずれでも吸収）
  function normalizeProgressValue(raw) {
    if (!isFiniteNum(raw)) return 0;
    if (raw < 0) return 0;
    if (raw <= 1) return raw;
    if (raw <= 100) return raw / 100;
    // それ以上はカウント想定（500 セッションで満タン）
    return clamp(raw / 500, 0, 1);
  }

  function readNormalizedProgress() {
    var src = safeReadProgress();
    return PATTERN_AXES.map(function (axis) {
      return {
        key: axis.key,
        label: axis.label,
        hue: axis.hue,
        value: normalizeProgressValue(src[axis.key])
      };
    });
  }

  // -------------------------------------------------------------
  // 2. Canvas dpr スケーリング
  // -------------------------------------------------------------
  function fitCanvasToCSS(canvas) {
    var dpr = (global.devicePixelRatio || 1);
    var rect = canvas.getBoundingClientRect();
    var cssW = Math.max(1, Math.floor(rect.width || canvas.clientWidth || 320));
    var cssH = Math.max(1, Math.floor(rect.height || canvas.clientHeight || 320));
    var pxW = Math.floor(cssW * dpr);
    var pxH = Math.floor(cssH * dpr);
    if (canvas.width !== pxW)  canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: cssW, h: cssH, dpr: dpr };
  }

  // -------------------------------------------------------------
  // 3. 放射状チャート描画（軸=8, 値=0-1）
  // -------------------------------------------------------------
  function drawRadialChart(ctx, cx, cy, radius, axes, rotationRad) {
    var n = axes.length;
    if (n < 3) return;

    // 背景同心円（4 リング・0.25 / 0.5 / 0.75 / 1.0 等分）
    ctx.save();
    ctx.lineWidth = 1;
    for (var r = 1; r <= 4; r++) {
      var rr = radius * (r / 4);
      ctx.beginPath();
      for (var i = 0; i < n; i++) {
        var ang = -Math.PI / 2 + rotationRad + (Math.PI * 2 * i / n);
        var x = cx + Math.cos(ang) * rr;
        var y = cy + Math.sin(ang) * rr;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = (r === 4) ? 'rgba(120,120,120,0.55)' : 'rgba(120,120,120,0.18)';
      ctx.stroke();
    }
    ctx.restore();

    // 軸線
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120,120,120,0.28)';
    for (var j = 0; j < n; j++) {
      var a = -Math.PI / 2 + rotationRad + (Math.PI * 2 * j / n);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
      ctx.stroke();
    }
    ctx.restore();

    // 値ポリゴン（塗り）
    ctx.save();
    ctx.beginPath();
    for (var k = 0; k < n; k++) {
      var ang2 = -Math.PI / 2 + rotationRad + (Math.PI * 2 * k / n);
      var v = clamp(axes[k].value, 0, 1);
      var rr2 = radius * v;
      var x2 = cx + Math.cos(ang2) * rr2;
      var y2 = cy + Math.sin(ang2) * rr2;
      if (k === 0) ctx.moveTo(x2, y2); else ctx.lineTo(x2, y2);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,180,255,0.18)';
    ctx.strokeStyle = 'rgba(120,180,255,0.85)';
    ctx.lineWidth = 1.6;
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 値ノード（軸色相で個別）
    for (var m = 0; m < n; m++) {
      var ang3 = -Math.PI / 2 + rotationRad + (Math.PI * 2 * m / n);
      var vv = clamp(axes[m].value, 0, 1);
      var rr3 = radius * vv;
      var nx = cx + Math.cos(ang3) * rr3;
      var ny = cy + Math.sin(ang3) * rr3;
      ctx.save();
      ctx.beginPath();
      ctx.arc(nx, ny, 4.2, 0, Math.PI * 2);
      ctx.fillStyle = 'hsl(' + axes[m].hue + ', 70%, 55%)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,20,20,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    // ラベル（外周・回転は適用しない＝可読性優先）
    ctx.save();
    ctx.font = '11px system-ui, -apple-system, "Noto Sans JP", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(50,50,50,0.92)';
    var labelR = radius + 16;
    for (var p = 0; p < n; p++) {
      // ラベル位置だけは静止させる（軸の最初の角度＝-PI/2 基準・回転無視）
      var la = -Math.PI / 2 + (Math.PI * 2 * p / n);
      var lx = cx + Math.cos(la) * labelR;
      var ly = cy + Math.sin(la) * labelR;
      ctx.fillText(axes[p].label, lx, ly);
    }
    ctx.restore();
  }

  // -------------------------------------------------------------
  // 4. 軽量 render(canvas, opts)  ── spec §58 互換
  //    現在拍ハイライトをドット列で描画（依存ゼロ・1 関数完結）
  //    opts: { beats?:number(default=4), currentBeat?:number(0-indexed) }
  // -------------------------------------------------------------
  function renderLight(canvas, opts) {
    if (!canvas || !canvas.getContext) return;
    var o = opts || {};
    var beats = isFiniteNum(o.beats) ? Math.max(1, Math.floor(o.beats)) : 4;
    var current = isFiniteNum(o.currentBeat) ? Math.floor(o.currentBeat) % beats : 0;

    var fit = fitCanvasToCSS(canvas);
    var ctx = fit.ctx, W = fit.w, H = fit.h;
    ctx.clearRect(0, 0, W, H);

    // ドット列（中央に水平配置）
    var dotR = Math.max(4, Math.min(W, H) * 0.06);
    var gap = dotR * 2.6;
    var totalW = (beats - 1) * gap;
    var startX = W / 2 - totalW / 2;
    var y = H / 2;

    for (var i = 0; i < beats; i++) {
      var x = startX + i * gap;
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      if (i === current) {
        ctx.fillStyle = 'rgba(255, 170, 60, 0.95)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(180,100,20,0.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(160,160,160,0.45)';
        ctx.fill();
      }
    }
  }

  // -------------------------------------------------------------
  // 5. mount(rootEl, opts) ── フル Beat Wheel UI
  //    opts:
  //      bpm:   number  // 既定 90。指定なければ window.__steadyBpm を試行
  //      stage: number  // 既定: localStorage QSKILL 結果から推定
  //      forceUnlock: boolean  // true なら Stage gate を無視
  //      bpmAccessor: () => number  // 動的 BPM 取得関数（毎フレーム呼ばれる）
  // -------------------------------------------------------------
  var _state = null; // 単一インスタンス（dispose 必須）

  function dispose() {
    if (!_state) return;
    try {
      if (_state.rafId) cancelAnimationFrame(_state.rafId);
      if (_state.resizeObserver && _state.resizeObserver.disconnect) {
        _state.resizeObserver.disconnect();
      }
      if (_state.windowResizeHandler) {
        global.removeEventListener('resize', _state.windowResizeHandler);
      }
      if (_state.storageHandler) {
        global.removeEventListener('storage', _state.storageHandler);
      }
      if (_state.root && _state.container && _state.container.parentNode === _state.root) {
        _state.root.removeChild(_state.container);
      }
    } catch (_) {}
    _state = null;
  }

  function buildContainer(doc) {
    var wrap = doc.createElement('div');
    wrap.className = 'steady-beat-wheel';
    wrap.setAttribute('data-component', 'steady-beat-wheel');
    wrap.style.cssText =
      'display:flex;flex-direction:column;align-items:stretch;gap:8px;' +
      'padding:12px;border:1px solid rgba(120,120,120,0.25);border-radius:10px;' +
      'background:rgba(255,255,255,0.55);max-width:520px;margin:0 auto;' +
      'font-family:system-ui,-apple-system,"Noto Sans JP",sans-serif;';

    var header = doc.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;';
    var title = doc.createElement('div');
    title.textContent = 'Beat Wheel  /  8 patterns 習熟度';
    title.style.cssText = 'font-size:13px;font-weight:600;color:#333;';
    var meta = doc.createElement('div');
    meta.className = 'steady-beat-wheel__meta';
    meta.style.cssText = 'font-size:11px;color:#666;';
    header.appendChild(title);
    header.appendChild(meta);

    var canvasWrap = doc.createElement('div');
    canvasWrap.style.cssText = 'position:relative;width:1' + '00%;aspect-ratio:1/1;max-height:420px;';
    var canvas = doc.createElement('canvas');
    canvas.className = 'steady-beat-wheel__canvas';
    canvas.style.cssText = 'width:1' + '00%;height:1' + '00%;display:block;';
    canvasWrap.appendChild(canvas);

    var foot = doc.createElement('div');
    foot.style.cssText = 'font-size:10px;color:#888;line-height:1.5;';
    foot.textContent = '中心 0 / 外周 1.0（習熟度を 0-1 正規化）。回転は BPM 連動。';

    wrap.appendChild(header);
    wrap.appendChild(canvasWrap);
    wrap.appendChild(foot);
    return { wrap: wrap, canvas: canvas, meta: meta };
  }

  function mount(rootEl, opts) {
    if (_state) dispose(); // 二重 mount 防止

    if (!rootEl || !rootEl.appendChild) {
      return { mounted: false, reason: 'invalid-root' };
    }

    var o = opts || {};
    var stage = isFiniteNum(o.stage) ? o.stage : readQSkillStage();
    var unlocked = !!o.forceUnlock || stage >= STAGE_GATE;

    var doc = rootEl.ownerDocument || document;
    var built = buildContainer(doc);
    rootEl.appendChild(built.wrap);

    if (!unlocked) {
      // ゲート時は静止メッセージのみ（描画ループ起動しない）
      var gate = doc.createElement('div');
      gate.style.cssText = 'padding:24px 12px;text-align:center;color:#666;font-size:12px;';
      gate.textContent = 'Beat Wheel は Stage ' + STAGE_GATE + ' 以上で解禁されます。現在 Stage ' + stage + '。';
      built.wrap.replaceChild(gate, built.canvas.parentNode);
      _state = {
        root: rootEl,
        container: built.wrap,
        canvas: null,
        meta: built.meta,
        rafId: null,
        bpmAccessor: null,
        rotationRad: 0,
        lastTs: 0,
        resizeObserver: null,
        windowResizeHandler: null,
        storageHandler: null,
        gateOnly: true
      };
      return { mounted: true, gated: true, stage: stage };
    }

    // BPM accessor（毎フレーム呼ばれる）
    var bpmAccessor = (typeof o.bpmAccessor === 'function')
      ? o.bpmAccessor
      : function () {
          if (isFiniteNum(o.bpm)) return o.bpm;
          // 動的 BPM の参照経路（既存実装に合わせて拡張可能）
          if (isFiniteNum(global.__steadyBpm)) return global.__steadyBpm;
          if (global.SteadyShared && isFiniteNum(global.SteadyShared.currentBpm)) {
            return global.SteadyShared.currentBpm;
          }
          return DEFAULT_BPM;
        };

    var st = {
      root: rootEl,
      container: built.wrap,
      canvas: built.canvas,
      meta: built.meta,
      rafId: null,
      bpmAccessor: bpmAccessor,
      rotationRad: 0,
      lastTs: 0,
      resizeObserver: null,
      windowResizeHandler: null,
      storageHandler: null,
      gateOnly: false,
      cachedAxes: readNormalizedProgress(),
      cachedAxesAt: 0
    };
    _state = st;

    // ResizeObserver（コンテナの幅変化に追従）
    if (typeof ResizeObserver !== 'undefined') {
      try {
        st.resizeObserver = new ResizeObserver(function () { /* render 側で fit する */ });
        st.resizeObserver.observe(built.canvas);
      } catch (_) { st.resizeObserver = null; }
    }
    st.windowResizeHandler = function () { /* render 側で fit する */ };
    global.addEventListener('resize', st.windowResizeHandler);

    // 進捗の即時反映（他タブからの更新も拾う）
    st.storageHandler = function (ev) {
      if (!ev || !ev.key) return;
      if (ev.key === 'steady_phase1_progress_v3_2') {
        st.cachedAxes = readNormalizedProgress();
        st.cachedAxesAt = Date.now();
      }
    };
    global.addEventListener('storage', st.storageHandler);

    // 描画ループ
    function loop(ts) {
      if (!_state || _state !== st) return;
      var dtMs = (st.lastTs > 0) ? (ts - st.lastTs) : 16.7;
      st.lastTs = ts;

      // BPM 連動回転速度（1 拍 = 30deg、1 小節=4 拍=120deg）
      // angularVelocity[rad/s] = (bpm / 60) * (2π / 4 拍)  = bpm * π / 120
      var bpm = clamp(Number(st.bpmAccessor()) || DEFAULT_BPM, MIN_BPM, MAX_BPM);
      var omega = bpm * Math.PI / 120; // rad/s
      st.rotationRad = (st.rotationRad + omega * (dtMs / 1000)) % (Math.PI * 2);

      // 進捗キャッシュ更新（500ms ごとに再読込）
      if (ts - st.cachedAxesAt > 500) {
        st.cachedAxes = readNormalizedProgress();
        st.cachedAxesAt = ts;
      }

      // メタ表示更新
      try {
        var sumPct = 0;
        for (var i = 0; i < st.cachedAxes.length; i++) sumPct += st.cachedAxes[i].value;
        var avgPct = Math.round((sumPct / st.cachedAxes.length) * 100);
        st.meta.textContent = 'BPM ' + Math.round(bpm) + '  /  平均 ' + avgPct + '%  /  Stage ' + stage;
      } catch (_) {}

      // 描画
      var fit = fitCanvasToCSS(st.canvas);
      var ctx = fit.ctx, W = fit.w, H = fit.h;
      ctx.clearRect(0, 0, W, H);
      var cx = W / 2;
      var cy = H / 2;
      var radius = Math.min(W, H) * 0.38;
      drawRadialChart(ctx, cx, cy, radius, st.cachedAxes, st.rotationRad);

      // 中央ハブ（軸数表示）
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, 14, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeStyle = 'rgba(120,120,120,0.55)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(60,60,60,0.85)';
      ctx.font = '10px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(PATTERN_AXES.length), cx, cy);
      ctx.restore();

      st.rafId = global.requestAnimationFrame(loop);
    }

    st.rafId = global.requestAnimationFrame(loop);

    return {
      mounted: true,
      gated: false,
      stage: stage,
      patternCount: PATTERN_AXES.length
    };
  }

  // -------------------------------------------------------------
  // 6. 公開
  // -------------------------------------------------------------
  global.SteadyBeatWheel = {
    mount: mount,
    render: renderLight,
    dispose: dispose,
    // 内部参照用（テスト・他モジュールからの読み取り専用）
    _meta: {
      version: 'v3.2.0r2-B8',
      patternAxes: PATTERN_AXES.slice(),
      stageGate: STAGE_GATE
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
