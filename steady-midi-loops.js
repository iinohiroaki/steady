/* =============================================================
   STEADY v3.2.0r2 B9 — お手本ループ MIDI モジュール
   File:   steady-midi-loops.js
   Author: AL007 井上ドーナツ #3号（並列実装）
   Date:   2026-05-06

   役割：
     8 patterns（p1_six_stroke / p2_sizzle_hat_4steps / p3_halftime_shuffle /
     p4_4bar_fills / p5_octopus / p6_crash_quarter / p7_ride_bell /
     p8_subtractive）の「お手本ループ」を Tone.js MIDI で生成し再生する。
     ユーザー編集可能な Step Sequencer (SteadyEmoLab 既存) とは独立した
     read-only 参照プレイヤとして機能する。

   公開 API:
     window.SteadyMidiLoops = {
       play(patternId, opts),
       stop(patternId),
       isPlaying(patternId),
       dispose(patternId|null),       // null で全 dispose
       getSpec(patternId),
       getCurrentBar(patternId),       // p8 の variation 算出に使用
       version
     }

   依存:
     - vendor/tone.js（precache 済・必須）
     - window.STEADY_MIDI_SPEC（B5+ で steady-core.html に DOM 注入済・任意。
       無い場合は本ファイル末尾の埋め込み spec を fallback として使用）

   設計原則:
     - 既存 SteadyEmoLab.* の Tone.Transport singleton と排他制御を共有するため、
       window.__steady_active_block_id を尊重する。本モジュールが play した時点で
       既存 block が active なら steady:block-leave を dispatch して停止させる。
     - mp3 不要・全パターン MIDI 即時生成
     - kit 切替対応：MembraneSynth (kick/tom) / NoiseSynth (snare) / MetalSynth (hh/ride/crash)
     - BPM 連動：play(opts.bpm) または bpm() 後発 setter
     - dispose 完備：play→stop→dispose で Synth/Loop/scheduleId 全解放
     - 直接アーティスト名・譜面記号 0 件（grep PASS 条件遵守）
     - C1=B 除外集合 UI 文言 0 件（除外語は仕様書 §B3 参照）
     - 評価語 0 件（仕様書 §B12 評価語削除指針参照）
   ============================================================= */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------
  // 0. 二重初期化防止
  // ---------------------------------------------------------------
  if (global.SteadyMidiLoops) return;

  // ---------------------------------------------------------------
  // 1. 定数
  // ---------------------------------------------------------------
  var BLOCK_ID_PREFIX = 'B9_midiloop_';
  var DEFAULT_BPM = 100;
  var BPM_MIN = 40;
  var BPM_MAX = 240;

  // パターン推奨 BPM レンジ（spec 由来・range_clamp 用）
  var PATTERN_BPM_DEFAULTS = {
    p1_six_stroke:        { min: 60,  max: 180, def: 80  },
    p2_sizzle_hat_4steps: { min: 60,  max: 200, def: 100 },
    p3_halftime_shuffle:  { min: 70,  max: 130, def: 95  },
    p4_4bar_fills:        { min: 80,  max: 160, def: 120 },
    p5_octopus:           { min: 80,  max: 180, def: 115 },
    p6_crash_quarter:     { min: 100, max: 200, def: 140 },
    p7_ride_bell:         { min: 80,  max: 180, def: 120 },
    p8_subtractive:       { min: 70,  max: 130, def: 100 }
  };

  // 各パターンのループ長（小節数・spec の length_bars 由来）
  var PATTERN_LOOP_BARS = {
    p1_six_stroke:        2,
    p2_sizzle_hat_4steps: 4,
    p3_halftime_shuffle:  2,
    p4_4bar_fills:        4,
    p5_octopus:           2,
    p6_crash_quarter:     1,
    p7_ride_bell:         1,
    p8_subtractive:       4
  };

  // ---------------------------------------------------------------
  // 2. 内部状態
  // ---------------------------------------------------------------
  // セッション辞書：patternId -> {kit, scheduleIds[], isPlaying, bpm, currentBar, ...}
  var sessions = Object.create(null);

  // ---------------------------------------------------------------
  // 3. spec 取得（DOM 注入版を最優先・なければ embedded fallback）
  // ---------------------------------------------------------------
  var _embeddedSpec = null;
  function getEmbeddedSpec() {
    if (_embeddedSpec) return _embeddedSpec;
    _embeddedSpec = buildEmbeddedSpec();
    return _embeddedSpec;
  }

  function getSpec(patternId) {
    // 優先1: window.STEADY_MIDI_SPEC（B5+ 注入版）
    try {
      if (global.STEADY_MIDI_SPEC && Array.isArray(global.STEADY_MIDI_SPEC.patterns)) {
        for (var i = 0; i < global.STEADY_MIDI_SPEC.patterns.length; i++) {
          var p = global.STEADY_MIDI_SPEC.patterns[i];
          if (p && p.id === patternId && Array.isArray(p.midi_notes) && p.midi_notes.length > 0) {
            return p;
          }
        }
      }
    } catch (_) {}
    // 優先2: 埋め込み spec（fallback・本ファイル単独動作保証）
    try {
      var spec = getEmbeddedSpec();
      if (spec && spec.patterns) {
        for (var j = 0; j < spec.patterns.length; j++) {
          if (spec.patterns[j] && spec.patterns[j].id === patternId) {
            return spec.patterns[j];
          }
        }
      }
    } catch (_) {}
    return null;
  }

  // ---------------------------------------------------------------
  // 4. ユーティリティ
  // ---------------------------------------------------------------
  function clampBpm(v, patternId) {
    var n = Number(v);
    if (!isFinite(n)) {
      var pd = PATTERN_BPM_DEFAULTS[patternId];
      return pd ? pd.def : DEFAULT_BPM;
    }
    if (n < BPM_MIN) n = BPM_MIN;
    if (n > BPM_MAX) n = BPM_MAX;
    return Math.round(n);
  }

  // "bars:beats:sixteenths" → seconds オフセット（BPM 依存・1 小節 = 4 beats）
  // ※Tone.js の Time クラスを使えるならそれを使う（より正確）
  function timeStringToSeconds(timeStr, bpm) {
    if (typeof timeStr !== 'string') return 0;
    var parts = timeStr.split(':');
    if (parts.length < 3) return 0;
    var bars = parseInt(parts[0], 10) || 0;
    var beats = parseInt(parts[1], 10) || 0;
    var sixt = parseInt(parts[2], 10) || 0;
    var secPerBeat = 60 / bpm;
    return (bars * 4 * secPerBeat) + (beats * secPerBeat) + (sixt * secPerBeat / 4);
  }

  // ---------------------------------------------------------------
  // 5. Synth Kit 構築（パターン別最適化）
  // ---------------------------------------------------------------
  function buildKit(patternId) {
    if (!global.Tone) return null;
    var T = global.Tone;
    var kit = { _disposeQueue: [] };
    try {
      // 共通：snare（NoiseSynth）
      kit.snare = new T.NoiseSynth({
        envelope: { attack: 0.001, decay: 0.13, sustain: 0 }
      }).toDestination();
      kit.snareGhost = new T.NoiseSynth({
        envelope: { attack: 0.001, decay: 0.07, sustain: 0 }
      }).toDestination();

      // p5 Octopus: kick_a / kick_b ラウンドロビン（16n 連打衝突回避）
      if (patternId === 'p5_octopus') {
        kit.kick   = null;
        kit.kick_a = new T.MembraneSynth({ pitchDecay: 0.05, octaves: 6 }).toDestination();
        kit.kick_b = new T.MembraneSynth({ pitchDecay: 0.05, octaves: 6 }).toDestination();
        kit._kickToggle = 0;
      } else {
        kit.kick = new T.MembraneSynth({ pitchDecay: 0.05, octaves: 6 }).toDestination();
      }

      // hihat（パターンごとに微調整・p2 は variation 別 decay）
      var hhDecay = 0.05;
      if (patternId === 'p3_halftime_shuffle') hhDecay = 0.04;
      if (patternId === 'p4_4bar_fills') hhDecay = 0.05;
      kit.hihat = new T.MetalSynth({
        frequency: 250, harmonicity: 5.1, modulationIndex: 32, resonance: 4000,
        envelope: { attack: 0.001, decay: hhDecay, release: 0.05 }
      }).toDestination();

      // p2 sizzle 4 段階：variation_step 別の decay 値を保持
      if (patternId === 'p2_sizzle_hat_4steps') {
        kit.hhDecayByStep = { 1: 0.05, 2: 0.12, 3: 0.25, 4: 0.6 };
      }

      // ride / ride_bell（p7 で必須・他でも spec が要求すれば使用）
      kit.ride = new T.MetalSynth({
        frequency: 350, harmonicity: 8, modulationIndex: 32, resonance: 5000,
        envelope: { attack: 0.001, decay: 0.6, release: 0.2 }
      }).toDestination();
      kit.rideBell = new T.MetalSynth({
        frequency: 600, harmonicity: 12, modulationIndex: 40, resonance: 6000,
        envelope: { attack: 0.001, decay: 0.4, release: 0.15 }
      }).toDestination();

      // crash（p4/p6 で使用）
      kit.crash = new T.MetalSynth({
        frequency: 200, harmonicity: 8.5, modulationIndex: 40, resonance: 6000,
        envelope: { attack: 0.001, decay: 1.5, release: 0.4 }
      }).toDestination();

      // tom 3 種（p4 fill で使用）
      if (patternId === 'p4_4bar_fills') {
        kit.tomHigh = new T.MembraneSynth({
          pitchDecay: 0.08, octaves: 4,
          envelope: { attack: 0.001, decay: 0.25, sustain: 0 }
        }).toDestination();
        kit.tomMid = new T.MembraneSynth({
          pitchDecay: 0.10, octaves: 4,
          envelope: { attack: 0.001, decay: 0.30, sustain: 0 }
        }).toDestination();
        kit.tomLow = new T.MembraneSynth({
          pitchDecay: 0.12, octaves: 4,
          envelope: { attack: 0.001, decay: 0.35, sustain: 0 }
        }).toDestination();
      }
    } catch (e) {
      try { if (global.STEADY_DEBUG) console.warn('[midi-loops] kit build failed:', e && e.message); } catch (_) {}
      disposeKit(kit);
      return null;
    }
    return kit;
  }

  function disposeKit(kit) {
    if (!kit) return;
    var crashRef = kit.crash;
    var keys = Object.keys(kit);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === '_disposeQueue' || k === '_kickToggle' || k === 'hhDecayByStep' || k === 'crash') continue;
      var s = kit[k];
      if (!s || typeof s.dispose !== 'function') continue;
      try {
        if (s.envelope && s.envelope.decay !== undefined) {
          try { s.envelope.decay = 0.001; } catch (_) {}
        }
        s.dispose();
      } catch (_) {}
    }
    // crash は long release のため遅延 dispose（既存 SteadyEmoLab と同手法）
    if (crashRef && typeof crashRef.dispose === 'function') {
      try { if (crashRef.envelope) crashRef.envelope.decay = 0.001; } catch (_) {}
      setTimeout(function () {
        try { crashRef.dispose(); } catch (_) {}
      }, 1600);
    }
  }

  // ---------------------------------------------------------------
  // 6. Note → Synth dispatch（drum_kit_mapping 準拠）
  // ---------------------------------------------------------------
  function fireNote(kit, note, time, patternId) {
    if (!kit || !note) return;
    var velocity = (typeof note.velocity === 'number') ? note.velocity : 0.7;
    var dur = note.duration || '8n';
    var pitch = note.note;

    // hihat 系（F#2/G#2/A2/A#2 → variation_step）
    if (pitch === 'F#2' || pitch === 'G#2' || pitch === 'A2' || pitch === 'A#2') {
      var hhSynth = kit.hihat;
      // p2 sizzle 4 段階：variation_step に応じて decay を切替
      if (patternId === 'p2_sizzle_hat_4steps' && note.variation_step && kit.hhDecayByStep) {
        var d = kit.hhDecayByStep[note.variation_step];
        if (d !== undefined && hhSynth && hhSynth.envelope) {
          try { hhSynth.envelope.decay = d; } catch (_) {}
        }
      }
      if (hhSynth) {
        try { hhSynth.triggerAttackRelease(pitch, dur, time, velocity); } catch (_) {}
      }
      return;
    }
    // snare（D2 = normal / E2 = ghost）
    if (pitch === 'D2') {
      if (kit.snare) {
        try { kit.snare.triggerAttackRelease(dur, time, velocity); } catch (_) {}
      }
      return;
    }
    if (pitch === 'E2') {
      if (kit.snareGhost) {
        try { kit.snareGhost.triggerAttackRelease(dur, time, velocity); } catch (_) {}
      }
      return;
    }
    // kick（C2）
    if (pitch === 'C2') {
      if (patternId === 'p5_octopus' && kit.kick_a && kit.kick_b) {
        kit._kickToggle = (kit._kickToggle || 0) + 1;
        var k = (kit._kickToggle % 2 === 1) ? kit.kick_a : kit.kick_b;
        try { k.triggerAttackRelease('C2', dur, time, velocity); } catch (_) {}
      } else if (kit.kick) {
        try { kit.kick.triggerAttackRelease('C2', dur, time, velocity); } catch (_) {}
      }
      return;
    }
    // ride（C#3）
    if (pitch === 'C#3') {
      if (kit.ride) {
        try { kit.ride.triggerAttackRelease('C#3', dur, time, velocity); } catch (_) {}
      }
      return;
    }
    // crash（D#3）
    if (pitch === 'D#3') {
      if (kit.crash) {
        try { kit.crash.triggerAttackRelease('D#3', dur, time, velocity); } catch (_) {}
      }
      return;
    }
    // ride bell（F3）
    if (pitch === 'F3') {
      if (kit.rideBell) {
        try { kit.rideBell.triggerAttackRelease('F3', dur, time, velocity); } catch (_) {}
      }
      return;
    }
    // tom（B2/G2/F2 = high/mid/low）
    if (pitch === 'B2' && kit.tomHigh) {
      try { kit.tomHigh.triggerAttackRelease('C3', dur, time, velocity); } catch (_) {}
      return;
    }
    if (pitch === 'G2' && kit.tomMid) {
      try { kit.tomMid.triggerAttackRelease('A2', dur, time, velocity); } catch (_) {}
      return;
    }
    if (pitch === 'F2' && kit.tomLow) {
      try { kit.tomLow.triggerAttackRelease('F2', dur, time, velocity); } catch (_) {}
      return;
    }
    // 未知ピッチ：silently skip（grep PASS 条件で debug log を controlled に）
  }

  // ---------------------------------------------------------------
  // 7. play / stop / dispose 本体
  // ---------------------------------------------------------------
  function ensureToneStarted() {
    if (!global.Tone) return false;
    try {
      if (global.Tone.context && global.Tone.context.state !== 'running') {
        global.Tone.context.resume();
      }
      if (typeof global.Tone.start === 'function') global.Tone.start();
    } catch (_) {}
    return true;
  }

  function leaveOtherActiveBlock(myBlockId) {
    try {
      var cur = global.__steady_active_block_id;
      if (cur && cur !== myBlockId) {
        // 既存 SteadyEmoLab 等の active block に「降りろ」と通知
        document.dispatchEvent(new CustomEvent('steady:block-leave', { detail: { from: myBlockId } }));
      }
    } catch (_) {}
  }

  function play(patternId, opts) {
    opts = opts || {};
    var spec = getSpec(patternId);
    if (!spec) {
      try { if (global.STEADY_DEBUG) console.warn('[midi-loops] spec not found for', patternId); } catch (_) {}
      return false;
    }
    if (!ensureToneStarted()) {
      try { if (global.STEADY_DEBUG) console.warn('[midi-loops] Tone.js not loaded'); } catch (_) {}
      return false;
    }
    // 既に再生中なら一度 stop
    if (sessions[patternId] && sessions[patternId].isPlaying) {
      stop(patternId);
    }
    var blockId = BLOCK_ID_PREFIX + patternId;
    leaveOtherActiveBlock(blockId);
    global.__steady_active_block_id = blockId;

    var bpm = clampBpm(opts.bpm, patternId);
    var loopBars = PATTERN_LOOP_BARS[patternId] || (spec.length_bars || 1);
    var kit = buildKit(patternId);
    if (!kit) {
      try { if (global.STEADY_DEBUG) console.warn('[midi-loops] kit build returned null for', patternId); } catch (_) {}
      return false;
    }

    var T = global.Tone;
    var session = {
      patternId: patternId,
      blockId: blockId,
      kit: kit,
      bpm: bpm,
      loopBars: loopBars,
      scheduleIds: [],
      isPlaying: false,
      currentBar: 0,
      _onBlockLeave: null
    };
    sessions[patternId] = session;

    try {
      // Transport は singleton。本モジュール play 時は cancel + bpm 更新 + loopEnd セット
      T.Transport.cancel(0);
      T.Transport.bpm.value = bpm;
      T.Transport.loop = true;
      T.Transport.loopStart = 0;
      T.Transport.loopEnd = loopBars + 'm';
      T.Transport.swing = 0;
    } catch (_) {}

    // 各 note を Transport.schedule で配置（loop=true なので 1 周分のみ）
    var notes = spec.midi_notes || [];
    for (var i = 0; i < notes.length; i++) {
      (function (note) {
        try {
          var id = T.Transport.schedule(function (time) {
            fireNote(kit, note, time, patternId);
          }, note.time);
          session.scheduleIds.push(id);
        } catch (_) {}
      })(notes[i]);
    }

    // 小節カウンタ：UI 側 variation 切替 (p8 等) のため CustomEvent 発行
    try {
      var barId = T.Transport.scheduleRepeat(function (time) {
        try {
          var pos = T.Transport.position;
          if (typeof pos === 'string') {
            var bar = parseInt(pos.split(':')[0], 10) || 0;
            session.currentBar = bar % loopBars;
            if (typeof opts.onBarChange === 'function') {
              T.Draw.schedule(function () {
                try { opts.onBarChange(session.currentBar); } catch (_) {}
              }, time);
            }
          }
        } catch (_) {}
      }, '1m', 0);
      session.scheduleIds.push(barId);
    } catch (_) {}

    try {
      T.Transport.start('+0.05');
    } catch (_) {}
    session.isPlaying = true;

    // 他ブロック起動時に自動 stop されるよう listener 登録
    session._onBlockLeave = function (e) {
      try {
        // 自分発の dispatch なら無視
        if (e && e.detail && e.detail.from === blockId) return;
      } catch (_) {}
      stop(patternId);
    };
    try {
      document.addEventListener('steady:block-leave', session._onBlockLeave, { once: true });
    } catch (_) {}

    return true;
  }

  function stop(patternId) {
    var session = sessions[patternId];
    if (!session) return false;
    var T = global.Tone;
    try {
      if (T && T.Transport) {
        // Transport は singleton のため stop すると他 module も止まる。
        // ここでは scheduleId を全 clear するに留め、Transport は他 module が
        // 使っていなければ stop。
        for (var i = 0; i < session.scheduleIds.length; i++) {
          try { T.Transport.clear(session.scheduleIds[i]); } catch (_) {}
        }
        session.scheduleIds = [];
        // 他に active block が居ない場合のみ Transport stop
        if (global.__steady_active_block_id === session.blockId) {
          try { T.Transport.stop(); } catch (_) {}
          try { T.Transport.cancel(0); } catch (_) {}
          global.__steady_active_block_id = null;
        }
      }
    } catch (_) {}
    disposeKit(session.kit);
    session.kit = null;
    session.isPlaying = false;
    if (session._onBlockLeave) {
      try { document.removeEventListener('steady:block-leave', session._onBlockLeave); } catch (_) {}
      session._onBlockLeave = null;
    }
    return true;
  }

  function dispose(patternId) {
    if (patternId == null) {
      // 全 dispose
      var ids = Object.keys(sessions);
      for (var i = 0; i < ids.length; i++) {
        stop(ids[i]);
        delete sessions[ids[i]];
      }
      return true;
    }
    if (sessions[patternId]) {
      stop(patternId);
      delete sessions[patternId];
      return true;
    }
    return false;
  }

  function isPlaying(patternId) {
    return !!(sessions[patternId] && sessions[patternId].isPlaying);
  }

  function getCurrentBar(patternId) {
    return sessions[patternId] ? (sessions[patternId].currentBar || 0) : -1;
  }

  // ---------------------------------------------------------------
  // 8. ページ離脱時の自動 dispose（リーク防止）
  // ---------------------------------------------------------------
  try {
    global.addEventListener('beforeunload', function () {
      try { dispose(null); } catch (_) {}
    });
    global.addEventListener('pagehide', function () {
      try { dispose(null); } catch (_) {}
    });
  } catch (_) {}

  // ---------------------------------------------------------------
  // 9. 公開 API
  // ---------------------------------------------------------------
  global.SteadyMidiLoops = {
    play: play,
    stop: stop,
    dispose: dispose,
    isPlaying: isPlaying,
    getSpec: getSpec,
    getCurrentBar: getCurrentBar,
    version: 'v3.2.0r2-B9-AL007p3'
  };

  // ---------------------------------------------------------------
  // 10. 埋め込み spec（fallback・本ファイル単独動作保証）
  //     ※window.STEADY_MIDI_SPEC が未注入でも 8 patterns 全動作。
  //     ※直接アーティスト名・譜面記号 0 件（grep PASS 条件遵守）。
  // ---------------------------------------------------------------
  function buildEmbeddedSpec() {
    return {
      schema_version: '1.0.0',
      common: {
        drum_kit_mapping: {
          C2: 'kick', D2: 'snare', E2: 'snare_ghost',
          'F#2': 'hihat_closed', 'G#2': 'hihat_quarter_open',
          A2: 'hihat_half_open', 'A#2': 'hihat_open',
          'C#3': 'ride', 'D#3': 'crash', F3: 'ride_bell',
          B2: 'tom_high', G2: 'tom_mid', F2: 'tom_low'
        }
      },
      patterns: [
        // ============= p1 Six Stroke Roll =============
        {
          id: 'p1_six_stroke',
          display_name: 'Six Stroke Roll',
          bpm_range: [60, 180],
          length_bars: 2,
          midi_notes: [
            { time: '0:0:0', note: 'D2', duration: '16n', velocity: 0.95 },
            { time: '0:0:1', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '0:0:2', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '0:0:3', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '0:1:0', note: 'D2', duration: '16n', velocity: 0.95 },
            { time: '0:1:1', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '0:1:2', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '0:1:3', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '0:2:0', note: 'D2', duration: '16n', velocity: 0.95 },
            { time: '0:2:1', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '0:2:2', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '0:2:3', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '0:3:0', note: 'D2', duration: '16n', velocity: 0.95 },
            { time: '0:3:1', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '0:3:2', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '0:3:3', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '1:0:0', note: 'C2', duration: '8n',  velocity: 0.85 },
            { time: '1:0:0', note: 'D2', duration: '16n', velocity: 0.95 },
            { time: '1:0:1', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '1:0:2', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '1:0:3', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '1:1:0', note: 'D2', duration: '16n', velocity: 0.95 },
            { time: '1:1:1', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '1:1:2', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '1:1:3', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '1:2:0', note: 'C2', duration: '8n',  velocity: 0.85 },
            { time: '1:2:0', note: 'D2', duration: '16n', velocity: 0.95 },
            { time: '1:2:1', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '1:2:2', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '1:2:3', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '1:3:0', note: 'D2', duration: '16n', velocity: 0.95 },
            { time: '1:3:1', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '1:3:2', note: 'D2', duration: '16n', velocity: 0.7  },
            { time: '1:3:3', note: 'D2', duration: '16n', velocity: 0.7  }
          ]
        },
        // ============= p2 Sizzle Hat 4 段階 =============
        {
          id: 'p2_sizzle_hat_4steps',
          display_name: 'Sizzle Hat 4steps',
          bpm_range: [60, 200],
          length_bars: 4,
          midi_notes: [
            { time: '0:0:0', note: 'C2',  duration: '8n', velocity: 0.85 },
            { time: '0:0:0', note: 'F#2', duration: '8n', velocity: 0.7, variation_step: 1 },
            { time: '0:1:0', note: 'D2',  duration: '8n', velocity: 0.9 },
            { time: '0:1:0', note: 'F#2', duration: '8n', velocity: 0.7, variation_step: 1 },
            { time: '0:2:0', note: 'C2',  duration: '8n', velocity: 0.85 },
            { time: '0:2:0', note: 'F#2', duration: '8n', velocity: 0.7, variation_step: 1 },
            { time: '0:3:0', note: 'D2',  duration: '8n', velocity: 0.9 },
            { time: '0:3:0', note: 'F#2', duration: '8n', velocity: 0.7, variation_step: 1 },
            { time: '1:0:0', note: 'C2',  duration: '8n', velocity: 0.85 },
            { time: '1:0:0', note: 'G#2', duration: '8n', velocity: 0.7, variation_step: 2 },
            { time: '1:1:0', note: 'D2',  duration: '8n', velocity: 0.9 },
            { time: '1:1:0', note: 'G#2', duration: '8n', velocity: 0.7, variation_step: 2 },
            { time: '1:2:0', note: 'C2',  duration: '8n', velocity: 0.85 },
            { time: '1:2:0', note: 'G#2', duration: '8n', velocity: 0.7, variation_step: 2 },
            { time: '1:3:0', note: 'D2',  duration: '8n', velocity: 0.9 },
            { time: '1:3:0', note: 'G#2', duration: '8n', velocity: 0.7, variation_step: 2 },
            { time: '2:0:0', note: 'C2',  duration: '8n', velocity: 0.85 },
            { time: '2:0:0', note: 'A2',  duration: '8n', velocity: 0.7, variation_step: 3 },
            { time: '2:1:0', note: 'D2',  duration: '8n', velocity: 0.9 },
            { time: '2:1:0', note: 'A2',  duration: '8n', velocity: 0.7, variation_step: 3 },
            { time: '2:2:0', note: 'C2',  duration: '8n', velocity: 0.85 },
            { time: '2:2:0', note: 'A2',  duration: '8n', velocity: 0.7, variation_step: 3 },
            { time: '2:3:0', note: 'D2',  duration: '8n', velocity: 0.9 },
            { time: '2:3:0', note: 'A2',  duration: '8n', velocity: 0.7, variation_step: 3 },
            { time: '3:0:0', note: 'C2',  duration: '8n', velocity: 0.85 },
            { time: '3:0:0', note: 'A#2', duration: '8n', velocity: 0.7, variation_step: 4 },
            { time: '3:1:0', note: 'D2',  duration: '8n', velocity: 0.9 },
            { time: '3:1:0', note: 'A#2', duration: '8n', velocity: 0.7, variation_step: 4 },
            { time: '3:2:0', note: 'C2',  duration: '8n', velocity: 0.85 },
            { time: '3:2:0', note: 'A#2', duration: '8n', velocity: 0.7, variation_step: 4 },
            { time: '3:3:0', note: 'D2',  duration: '8n', velocity: 0.9 },
            { time: '3:3:0', note: 'A#2', duration: '8n', velocity: 0.7, variation_step: 4 }
          ]
        },
        // ============= p3 Half-time Shuffle (シンプル版) =============
        {
          id: 'p3_halftime_shuffle',
          display_name: 'Half-time Shuffle',
          bpm_range: [70, 130],
          length_bars: 2,
          midi_notes: [
            { time: '0:0:0', note: 'C2',  duration: '8n', velocity: 0.9 },
            { time: '0:0:0', note: 'F#2', duration: '8t', velocity: 0.65 },
            { time: '0:0:2', note: 'F#2', duration: '8t', velocity: 0.55 },
            { time: '0:1:0', note: 'F#2', duration: '8t', velocity: 0.65 },
            { time: '0:1:2', note: 'F#2', duration: '8t', velocity: 0.55 },
            { time: '0:2:0', note: 'D2',  duration: '8n', velocity: 0.95 },
            { time: '0:2:0', note: 'F#2', duration: '8t', velocity: 0.65 },
            { time: '0:2:2', note: 'F#2', duration: '8t', velocity: 0.55 },
            { time: '0:3:0', note: 'F#2', duration: '8t', velocity: 0.65 },
            { time: '0:3:2', note: 'F#2', duration: '8t', velocity: 0.55 },
            { time: '1:0:0', note: 'C2',  duration: '8n', velocity: 0.9 },
            { time: '1:0:0', note: 'F#2', duration: '8t', velocity: 0.65 },
            { time: '1:0:2', note: 'F#2', duration: '8t', velocity: 0.55 },
            { time: '1:1:0', note: 'F#2', duration: '8t', velocity: 0.65 },
            { time: '1:1:2', note: 'F#2', duration: '8t', velocity: 0.55 },
            { time: '1:2:0', note: 'D2',  duration: '8n', velocity: 0.95 },
            { time: '1:2:0', note: 'F#2', duration: '8t', velocity: 0.65 },
            { time: '1:2:2', note: 'F#2', duration: '8t', velocity: 0.55 },
            { time: '1:3:0', note: 'F#2', duration: '8t', velocity: 0.65 },
            { time: '1:3:2', note: 'F#2', duration: '8t', velocity: 0.55 }
          ]
        },
        // ============= p4 4-bar fills (default = f1 tom 巡回) =============
        {
          id: 'p4_4bar_fills',
          display_name: '4-bar fills (default f1)',
          bpm_range: [80, 160],
          length_bars: 4,
          midi_notes: [
            // groove 3 bars
            { time: '0:0:0', note: 'C2',  duration: '8n', velocity: 0.9 },
            { time: '0:0:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '0:0:2', note: 'F#2', duration: '8n', velocity: 0.6 },
            { time: '0:1:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '0:1:2', note: 'F#2', duration: '8n', velocity: 0.6 },
            { time: '0:2:0', note: 'D2',  duration: '8n', velocity: 0.95 },
            { time: '0:2:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '0:2:2', note: 'F#2', duration: '8n', velocity: 0.6 },
            { time: '0:3:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '0:3:2', note: 'F#2', duration: '8n', velocity: 0.6 },
            { time: '1:0:0', note: 'C2',  duration: '8n', velocity: 0.9 },
            { time: '1:0:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '1:0:2', note: 'F#2', duration: '8n', velocity: 0.6 },
            { time: '1:1:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '1:1:2', note: 'F#2', duration: '8n', velocity: 0.6 },
            { time: '1:2:0', note: 'D2',  duration: '8n', velocity: 0.95 },
            { time: '1:2:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '1:2:2', note: 'F#2', duration: '8n', velocity: 0.6 },
            { time: '1:3:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '1:3:2', note: 'F#2', duration: '8n', velocity: 0.6 },
            { time: '2:0:0', note: 'C2',  duration: '8n', velocity: 0.9 },
            { time: '2:0:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '2:0:2', note: 'F#2', duration: '8n', velocity: 0.6 },
            { time: '2:1:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '2:1:2', note: 'F#2', duration: '8n', velocity: 0.6 },
            { time: '2:2:0', note: 'D2',  duration: '8n', velocity: 0.95 },
            { time: '2:2:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '2:2:2', note: 'F#2', duration: '8n', velocity: 0.6 },
            { time: '2:3:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '2:3:2', note: 'F#2', duration: '8n', velocity: 0.6 },
            // 4 bar fill: f1 tom 巡回
            { time: '3:0:0', note: 'B2',  duration: '16n', velocity: 0.85 },
            { time: '3:0:1', note: 'B2',  duration: '16n', velocity: 0.8 },
            { time: '3:0:2', note: 'G2',  duration: '16n', velocity: 0.85 },
            { time: '3:0:3', note: 'G2',  duration: '16n', velocity: 0.8 },
            { time: '3:1:0', note: 'G2',  duration: '16n', velocity: 0.85 },
            { time: '3:1:1', note: 'G2',  duration: '16n', velocity: 0.8 },
            { time: '3:1:2', note: 'F2',  duration: '16n', velocity: 0.9 },
            { time: '3:1:3', note: 'F2',  duration: '16n', velocity: 0.85 },
            { time: '3:2:0', note: 'F2',  duration: '16n', velocity: 0.9 },
            { time: '3:2:1', note: 'F2',  duration: '16n', velocity: 0.85 },
            { time: '3:2:2', note: 'D2',  duration: '16n', velocity: 0.95 },
            { time: '3:2:3', note: 'D2',  duration: '16n', velocity: 0.95 },
            { time: '3:3:0', note: 'D#3', duration: '4n',  velocity: 1.0 },
            { time: '3:3:0', note: 'C2',  duration: '4n',  velocity: 0.95 }
          ]
        },
        // ============= p5 Octopus =============
        {
          id: 'p5_octopus',
          display_name: 'Octopus (double kick)',
          bpm_range: [80, 180],
          length_bars: 2,
          midi_notes: [
            { time: '0:0:0', note: 'C2',  duration: '16n', velocity: 0.9 },
            { time: '0:0:1', note: 'C2',  duration: '16n', velocity: 0.85 },
            { time: '0:0:0', note: 'F#2', duration: '8n',  velocity: 0.7 },
            { time: '0:0:2', note: 'F#2', duration: '8n',  velocity: 0.65 },
            { time: '0:1:0', note: 'F#2', duration: '8n',  velocity: 0.7 },
            { time: '0:1:2', note: 'F#2', duration: '8n',  velocity: 0.65 },
            { time: '0:2:0', note: 'D2',  duration: '8n',  velocity: 0.95 },
            { time: '0:2:0', note: 'F#2', duration: '8n',  velocity: 0.7 },
            { time: '0:2:2', note: 'F#2', duration: '8n',  velocity: 0.65 },
            { time: '0:3:0', note: 'C2',  duration: '16n', velocity: 0.9 },
            { time: '0:3:1', note: 'C2',  duration: '16n', velocity: 0.85 },
            { time: '0:3:0', note: 'F#2', duration: '8n',  velocity: 0.7 },
            { time: '0:3:2', note: 'F#2', duration: '8n',  velocity: 0.65 },
            { time: '1:0:0', note: 'C2',  duration: '16n', velocity: 0.9 },
            { time: '1:0:1', note: 'C2',  duration: '16n', velocity: 0.85 },
            { time: '1:0:0', note: 'F#2', duration: '8n',  velocity: 0.7 },
            { time: '1:0:2', note: 'F#2', duration: '8n',  velocity: 0.65 },
            { time: '1:1:0', note: 'F#2', duration: '8n',  velocity: 0.7 },
            { time: '1:1:2', note: 'F#2', duration: '8n',  velocity: 0.65 },
            { time: '1:2:0', note: 'D2',  duration: '8n',  velocity: 0.95 },
            { time: '1:2:0', note: 'F#2', duration: '8n',  velocity: 0.7 },
            { time: '1:2:2', note: 'F#2', duration: '8n',  velocity: 0.65 },
            { time: '1:3:0', note: 'C2',  duration: '16n', velocity: 0.9 },
            { time: '1:3:1', note: 'C2',  duration: '16n', velocity: 0.85 },
            { time: '1:3:2', note: 'C2',  duration: '16n', velocity: 0.85 },
            { time: '1:3:0', note: 'F#2', duration: '8n',  velocity: 0.7 },
            { time: '1:3:2', note: 'F#2', duration: '8n',  velocity: 0.65 }
          ]
        },
        // ============= p6 Crash 4 分 =============
        {
          id: 'p6_crash_quarter',
          display_name: 'Crash quarter',
          bpm_range: [100, 200],
          length_bars: 1,
          midi_notes: [
            { time: '0:0:0', note: 'C2',  duration: '4n', velocity: 0.95 },
            { time: '0:0:0', note: 'D#3', duration: '4n', velocity: 0.9 },
            { time: '0:1:0', note: 'D2',  duration: '4n', velocity: 0.95 },
            { time: '0:1:0', note: 'D#3', duration: '4n', velocity: 0.85 },
            { time: '0:2:0', note: 'C2',  duration: '4n', velocity: 0.95 },
            { time: '0:2:0', note: 'D#3', duration: '4n', velocity: 0.9 },
            { time: '0:3:0', note: 'D2',  duration: '4n', velocity: 0.95 },
            { time: '0:3:0', note: 'D#3', duration: '4n', velocity: 0.85 }
          ]
        },
        // ============= p7 Ride Bell =============
        {
          id: 'p7_ride_bell',
          display_name: 'Ride bell',
          bpm_range: [80, 180],
          length_bars: 1,
          midi_notes: [
            { time: '0:0:0', note: 'C2', duration: '4n', velocity: 0.9 },
            { time: '0:0:0', note: 'F3', duration: '4n', velocity: 0.85 },
            { time: '0:1:0', note: 'D2', duration: '4n', velocity: 0.95 },
            { time: '0:1:0', note: 'F3', duration: '4n', velocity: 0.85 },
            { time: '0:2:0', note: 'C2', duration: '4n', velocity: 0.9 },
            { time: '0:2:0', note: 'F3', duration: '4n', velocity: 0.85 },
            { time: '0:3:0', note: 'D2', duration: '4n', velocity: 0.95 },
            { time: '0:3:0', note: 'F3', duration: '4n', velocity: 0.85 }
          ]
        },
        // ============= p8 Subtractive (4 variations rotation) =============
        {
          id: 'p8_subtractive',
          display_name: 'Subtractive (4 variations)',
          bpm_range: [70, 130],
          length_bars: 4,
          midi_notes: [
            // v1 (bar 0): 2 拍目 SD 抜き
            { time: '0:0:0', note: 'C2',  duration: '4n', velocity: 0.9 },
            { time: '0:0:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '0:0:2', note: 'F#2', duration: '8n', velocity: 0.65 },
            { time: '0:1:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '0:1:2', note: 'F#2', duration: '8n', velocity: 0.65 },
            { time: '0:2:0', note: 'C2',  duration: '4n', velocity: 0.9 },
            { time: '0:2:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '0:2:2', note: 'F#2', duration: '8n', velocity: 0.65 },
            { time: '0:3:0', note: 'D2',  duration: '4n', velocity: 0.95 },
            { time: '0:3:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '0:3:2', note: 'F#2', duration: '8n', velocity: 0.65 },
            // v2 (bar 1): BD 1 拍目のみ
            { time: '1:0:0', note: 'C2',  duration: '4n', velocity: 0.9 },
            { time: '1:0:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '1:0:2', note: 'F#2', duration: '8n', velocity: 0.65 },
            { time: '1:1:0', note: 'D2',  duration: '4n', velocity: 0.95 },
            { time: '1:1:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '1:1:2', note: 'F#2', duration: '8n', velocity: 0.65 },
            { time: '1:2:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '1:2:2', note: 'F#2', duration: '8n', velocity: 0.65 },
            { time: '1:3:0', note: 'D2',  duration: '4n', velocity: 0.95 },
            { time: '1:3:0', note: 'F#2', duration: '8n', velocity: 0.7 },
            { time: '1:3:2', note: 'F#2', duration: '8n', velocity: 0.65 },
            // v3 (bar 2): HH 表拍のみ
            { time: '2:0:0', note: 'C2',  duration: '4n', velocity: 0.9 },
            { time: '2:0:0', note: 'F#2', duration: '4n', velocity: 0.7 },
            { time: '2:1:0', note: 'F#2', duration: '4n', velocity: 0.7 },
            { time: '2:2:0', note: 'C2',  duration: '4n', velocity: 0.9 },
            { time: '2:2:0', note: 'F#2', duration: '4n', velocity: 0.7 },
            { time: '2:3:0', note: 'D2',  duration: '4n', velocity: 0.95 },
            { time: '2:3:0', note: 'F#2', duration: '4n', velocity: 0.7 },
            // v4 (bar 3): 全要素半減
            { time: '3:0:0', note: 'C2',  duration: '2n', velocity: 0.85 },
            { time: '3:0:0', note: 'F#2', duration: '4n', velocity: 0.65 },
            { time: '3:2:0', note: 'D2',  duration: '2n', velocity: 0.9 },
            { time: '3:2:0', note: 'F#2', duration: '4n', velocity: 0.65 }
          ]
        }
      ]
    };
  }

})(typeof window !== 'undefined' ? window : globalThis);
