/* =============================================================
   STEADY v3.2.0r2-block8 — SteadyEmoLab shared module（共通基盤）
   - core.html L1175-1479 抜粋（B8 Run 2 / T-04 module split）
   - 役割：MIDI spec ローダ・BPM clamp・Tone.Transport 排他・LS ラッパ
           ・Step Sequencer 4×16 基盤・Synth Pool・BeatWheel
   - p1〜p8 の mount/unmount は steady-emolab-p1p4.js / steady-emolab-p5p8.js
   - 公開 API（mount router / unmount / version）は p5p8.js が最後に上書き
   - p1p4.js / p5p8.js から helper を共有するため
     window.SteadyEmoLab._helper.* に内部関数を bridge する
   ============================================================= */

(function (global) {
  'use strict';

  // 二重初期化防止（shared が先頭ロード固定なのでここで作る）
  if (global.SteadyEmoLab && global.SteadyEmoLab._shared_loaded) return;
  global.SteadyEmoLab = global.SteadyEmoLab || {};
  global.SteadyEmoLab._helper = global.SteadyEmoLab._helper || {};

  // defensive 初期化（B11 までの no-op API 契約）
  global.SteadyWobble = global.SteadyWobble || { capture: function () {} };

  // ---------------------------------------------------------
  // MIDI spec ローダ（DOM 注入の <script type="application/json"> から取得）
  // ---------------------------------------------------------
  var _midiSpec = null;
  function loadMidiSpec() {
    if (_midiSpec) return _midiSpec;
    try {
      var el = document.getElementById('steady-midi-spec');
      if (!el) { if (global.STEADY_DEBUG) console.warn('[emolab] steady-midi-spec script not found'); return null; }
      _midiSpec = JSON.parse(el.textContent || el.innerText || '{}');
      global.STEADY_MIDI_SPEC = _midiSpec;
      return _midiSpec;
    } catch (e) {
      if (global.STEADY_DEBUG) console.warn('[emolab] midi-spec parse failed:', e && e.message);
      return null;
    }
  }
  function getPatternSpec(patternId) {
    var spec = loadMidiSpec();
    if (!spec || !spec.patterns) return null;
    for (var i = 0; i < spec.patterns.length; i++) {
      if (spec.patterns[i].id === patternId) return spec.patterns[i];
    }
    return null;
  }

  // ---------------------------------------------------------
  // BPM 検証
  // ---------------------------------------------------------
  function clampBpm(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (n < 40 || n > 240) return null;
    return Math.round(n);
  }

  // ---------------------------------------------------------
  // Tone.Transport 排他 — block 切替時に cleanup を発火
  // ---------------------------------------------------------
  function leaveActiveBlock() {
    var prev = global.__steady_active_block_id;
    if (prev) {
      try { document.dispatchEvent(new CustomEvent('steady:block-leave', { detail: { blockId: prev } })); } catch (_) {}
    }
    global.__steady_active_block_id = null;
  }

  // ---------------------------------------------------------
  // localStorage 共通ラッパ（SteadyShared 経由 / fallback）
  // ---------------------------------------------------------
  function lsGetSafe(key, fallback) {
    if (global.SteadyShared && typeof global.SteadyShared.lsGet === 'function') return global.SteadyShared.lsGet(key, fallback);
    try { var v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (_) { return fallback; }
  }
  function lsSetSafe(key, value) {
    if (global.SteadyShared && typeof global.SteadyShared.lsSet === 'function') return global.SteadyShared.lsSet(key, value);
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  }
  function lsPhase1Progress() {
    var key = (global.SteadyShared && global.SteadyShared.LS_V32 && global.SteadyShared.LS_V32.PHASE1_PROGRESS) || 'steady_phase1_progress_v3_2';
    return { key: key, value: lsGetSafe(key, {}) };
  }
  function lsBumpPhase1Progress(progressId, delta, max) {
    var box = lsPhase1Progress();
    var cur = (box.value && typeof box.value[progressId] === 'number') ? box.value[progressId] : 0;
    var next = cur + delta;
    if (next > max) next = max;
    if (next < 0) next = 0;
    box.value[progressId] = next;
    lsSetSafe(box.key, box.value);
    return next;
  }

  // ---------------------------------------------------------
  // Step Sequencer 4×16 共通基盤
  // ---------------------------------------------------------
  var ROWS = ['HH', 'SD', 'BD', 'Cymbals'];
  var STATE_CYCLE = ['off', 'normal', 'accent', 'ghost'];
  var STATE_VELOCITY = { off: 0, ghost: 0.35, normal: 0.7, accent: 0.95 };

  function makeEmptySteps() {
    var out = {};
    ROWS.forEach(function (r) {
      out[r] = [];
      for (var i = 0; i < 16; i++) out[r].push('off');
    });
    return out;
  }

  // notes ([{time, note, velocity, ...}]) → row/step state map
  function notesToSteps(notes) {
    var steps = makeEmptySteps();
    if (!Array.isArray(notes)) return steps;
    notes.forEach(function (n) {
      var row = noteToRow(n.note);
      if (!row) return;
      var idx = timeToStep(n.time);
      if (idx == null || idx < 0 || idx > 15) return;
      var v = typeof n.velocity === 'number' ? n.velocity : 0.7;
      var state = velocityToState(v);
      // 既に入っている場合は上書き優先：accent > normal > ghost
      var prev = steps[row][idx];
      var rank = { off: 0, ghost: 1, normal: 2, accent: 3 };
      if ((rank[state] || 0) > (rank[prev] || 0)) steps[row][idx] = state;
    });
    return steps;
  }
  function noteToRow(note) {
    if (!note) return null;
    if (note === 'C2') return 'BD';
    if (note === 'D2' || note === 'E2') return 'SD';
    if (note === 'F#2' || note === 'G#2' || note === 'A2' || note === 'A#2') return 'HH';
    if (note === 'D#3' || note === 'C#3' || note === 'F3') return 'Cymbals';
    return null;
  }
  function velocityToState(v) {
    if (v >= 0.9) return 'accent';
    if (v >= 0.5) return 'normal';
    if (v > 0) return 'ghost';
    return 'off';
  }
  // time format "0:0:0"〜"0:3:3" を 1 小節 = 16 step に投影（bar > 0 は無視）
  function timeToStep(time) {
    if (typeof time !== 'string') return null;
    var parts = time.split(':');
    if (parts.length < 3) return null;
    var bars = parseInt(parts[0], 10);
    var beats = parseInt(parts[1], 10);
    var sixt = parseInt(parts[2], 10);
    if (bars > 0) return null; // 表示は最初の 1 小節分（B4 の Step Seq は 4×16）
    return beats * 4 + sixt;
  }

  // ---------------------------------------------------------
  // Synth Pool — block ごとに kit を生成し dispose を保証
  // ---------------------------------------------------------
  function buildKitFor(patternId) {
    if (!global.Tone) return null;
    var kit = {};
    try {
      kit.snare = new global.Tone.NoiseSynth({ envelope: { attack: 0.001, decay: 0.13, sustain: 0 } }).toDestination();
      kit.kick  = new global.Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 6 }).toDestination();
      if (patternId === 'p2_sizzle_hat_4steps') {
        kit.hihat = new global.Tone.MetalSynth({
          frequency: 250, harmonicity: 5.1, modulationIndex: 32, resonance: 4000,
          envelope: { attack: 0.001, decay: 0.05, release: 0.05 }
        }).toDestination();
      }
      // B5 p3：shuffle 用 hihat（軽量 closed タイプ）
      if (patternId === 'p3_halftime_shuffle') {
        kit.hihat = new global.Tone.MetalSynth({
          frequency: 320, harmonicity: 5.1, modulationIndex: 32, resonance: 4000,
          envelope: { attack: 0.001, decay: 0.04, release: 0.04 }
        }).toDestination();
      }
      // B6 p5：両手両足同時系。BD は 16n 連打衝突回避のため kick_a/kick_b ラウンドロビン
      if (patternId === 'p5_octopus') {
        kit.kick   = null; // 16n 連打用は kick_a/kick_b を使用（既定 kick は disposeKit 対象外なので明示 null）
        kit.kick_a = new global.Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 6 }).toDestination();
        kit.kick_b = new global.Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 6 }).toDestination();
        kit.hihat  = new global.Tone.MetalSynth({
          frequency: 250, harmonicity: 5.1, modulationIndex: 32, resonance: 4000,
          envelope: { attack: 0.001, decay: 0.05, release: 0.05 }
        }).toDestination();
      }
      // B6 p6：Crash 4 分（kick + snare + crash 長 release）
      if (patternId === 'p6_crash_quarter') {
        kit.crash = new global.Tone.MetalSynth({
          frequency: 200, harmonicity: 8.5, modulationIndex: 40, resonance: 6000,
          envelope: { attack: 0.001, decay: 1.5, release: 0.4 }
        }).toDestination();
      }
      // B7 p7：Ride Bell（kick + snare + ride_bell MetalSynth 高周波）
      if (patternId === 'p7_ride_bell') {
        kit.ride_bell = new global.Tone.MetalSynth({
          frequency: 600, harmonicity: 12, modulationIndex: 40, resonance: 5000,
          envelope: { attack: 0.001, decay: 0.4, release: 0.05 }
        }).toDestination();
      }
      // B7 p8：Subtractive（kick + snare + hihat 標準）
      if (patternId === 'p8_subtractive') {
        kit.hihat = new global.Tone.MetalSynth({
          frequency: 250, harmonicity: 5.1, modulationIndex: 32, resonance: 4000,
          envelope: { attack: 0.001, decay: 0.05, release: 0.05 }
        }).toDestination();
      }
      // B5 p4：tom 3 種 + crash + hihat（fill 種別ごとに使い分け）
      if (patternId === 'p4_4bar_fills') {
        kit.hihat = new global.Tone.MetalSynth({
          frequency: 280, harmonicity: 5.1, modulationIndex: 32, resonance: 4000,
          envelope: { attack: 0.001, decay: 0.05, release: 0.05 }
        }).toDestination();
        // tom 3 種：MembraneSynth で pitch を変えて区別
        kit.tomHigh = new global.Tone.MembraneSynth({ pitchDecay: 0.08, octaves: 4, envelope: { attack: 0.001, decay: 0.25, sustain: 0 } }).toDestination();
        kit.tomMid  = new global.Tone.MembraneSynth({ pitchDecay: 0.10, octaves: 4, envelope: { attack: 0.001, decay: 0.30, sustain: 0 } }).toDestination();
        kit.tomLow  = new global.Tone.MembraneSynth({ pitchDecay: 0.12, octaves: 4, envelope: { attack: 0.001, decay: 0.35, sustain: 0 } }).toDestination();
        // crash：MetalSynth 長 release（dispose 前に decay 落とす運用）
        kit.crash = new global.Tone.MetalSynth({
          frequency: 200, harmonicity: 8.5, modulationIndex: 40, resonance: 6000,
          envelope: { attack: 0.001, decay: 1.4, release: 0.4 }
        }).toDestination();
      }
    } catch (e) {
      if (global.STEADY_DEBUG) console.warn('[emolab] kit build failed:', e && e.message);
      return null;
    }
    return kit;
  }
  function disposeKit(kit) {
    if (!kit) return;
    // crash は long release のため、decay を絞ってから 1600ms 後に dispose（クリックノイズ回避・B5 仕様）
    var crash = kit.crash;
    Object.keys(kit).forEach(function (k) {
      if (k === 'crash') return; // 後段で個別処理
      var s = kit[k];
      if (!s) return;
      try {
        if (s.envelope && s.envelope.decay !== undefined) {
          try { s.envelope.decay = 0.001; } catch (_) {}
        }
        if (typeof s.dispose === 'function') s.dispose();
      } catch (_) {}
    });
    if (crash) {
      try { if (crash.envelope) crash.envelope.decay = 0.001; } catch (_) {}
      setTimeout(function () {
        try { if (typeof crash.dispose === 'function') crash.dispose(); } catch (_) {}
      }, 1600);
    }
  }

  // ---------------------------------------------------------
  // BeatWheel lite (Canvas 2D / 4 拍 sector / 現在拍ハイライト)
  // ---------------------------------------------------------
  global.SteadyBeatWheel = global.SteadyBeatWheel || {};
  global.SteadyBeatWheel.render = function (canvas, opts) {
    if (!canvas || !canvas.getContext) return;
    var beats = (opts && opts.beats) || 4;
    var current = (opts && typeof opts.currentBeat === 'number') ? opts.currentBeat : -1;
    var dpr = global.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var size = Math.min(rect.width, rect.height) || 200;
    // B4 採用：サブピクセル丸め誤差防止のため Math.ceil で安全側に倒す
    canvas.width = Math.ceil(size * dpr);
    canvas.height = Math.ceil(size * dpr);
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    var cx = size / 2, cy = size / 2;
    var r = size * 0.42;
    var styles = global.getComputedStyle ? getComputedStyle(document.body) : null;
    var bgCard  = (styles && styles.getPropertyValue('--bg').trim()) || '#fff';
    var ink2    = (styles && styles.getPropertyValue('--border').trim()) || '#ccc';
    var accent  = (styles && styles.getPropertyValue('--accent').trim()) || '#7c6af7';
    // 12時方向 = beat 1, 時計回り
    for (var i = 0; i < beats; i++) {
      var startAngle = -Math.PI / 2 + (i * 2 * Math.PI / beats);
      var endAngle   = -Math.PI / 2 + ((i + 1) * 2 * Math.PI / beats);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = (i === current) ? accent : bgCard;
      ctx.fill();
      ctx.strokeStyle = ink2;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // 中央数字
    ctx.fillStyle = (styles && styles.getPropertyValue('--text').trim()) || '#222';
    ctx.font = (Math.round(size * 0.18)) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(beats), cx, cy);
  };

  // ---------------------------------------------------------
  // _helper bridging — p1p4.js / p5p8.js から呼ばれる private 関数を共有
  // ---------------------------------------------------------
  var H = global.SteadyEmoLab._helper;
  H.loadMidiSpec        = loadMidiSpec;
  H.getPatternSpec      = getPatternSpec;
  H.clampBpm            = clampBpm;
  H.leaveActiveBlock    = leaveActiveBlock;
  H.lsGetSafe           = lsGetSafe;
  H.lsSetSafe           = lsSetSafe;
  H.lsBumpPhase1Progress = lsBumpPhase1Progress;
  H.makeEmptySteps      = makeEmptySteps;
  H.notesToSteps        = notesToSteps;
  H.timeToStep          = timeToStep;
  H.buildKitFor         = buildKitFor;
  H.disposeKit          = disposeKit;
  H.ROWS                = ROWS;
  H.STATE_CYCLE         = STATE_CYCLE;
  H.STATE_VELOCITY      = STATE_VELOCITY;

  // 公開 API（一部は p5p8.js が後段で上書き：mount / unmount / version / toggleKbdHelp）
  global.SteadyEmoLab.loadMidiSpec     = loadMidiSpec;
  global.SteadyEmoLab.getPatternSpec   = getPatternSpec;
  global.SteadyEmoLab.leaveActiveBlock = leaveActiveBlock;

  global.SteadyEmoLab._shared_loaded = true;
})(typeof window !== 'undefined' ? window : globalThis);
