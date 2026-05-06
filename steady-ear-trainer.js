/* ============================================================
 * STEADY v3.2.0r2 — Ear Trainer Module (B15a-e 5種統合)
 * Phase 1.5 + Phase 2 統合・mp3 不要・全 Tone.js 合成
 *
 * 著者：AL007 井上ドーナツ #6号（並列実装）
 * 監査状況：CEO 単独起案・監査未経由（AL011/AL012/EMP002 後段）
 * 発注書：2026-05-06_AL007_steady_v3.2.0r2_phase1_master.md §B15a-e
 * 仕様書：steady-ear-samples-spec.json（wobble_ms_a/b を Tone.js
 *         scheduleAtTime offset として直接使用・mp3 precache 0MB）
 *
 * 提供ゲーム種：
 *   B15a wobble_ab     : 微妙な揺らぎ A/B 比較（spec 40 ペア準拠）
 *   B15b dynamics_diff : 強弱（dB）差 A/B 比較（30 ペア）
 *   B15c timing_offset : タイミングずれ（ms）A/B 比較（30 ペア）
 *   B15d timbre_nuance : 音色ニュアンス A/B 比較（30 ペア）
 *   B15e freq_response : 周波数特性 A/B 比較（30 ペア）
 *
 * 公開 API：
 *   window.SteadyEarTrainer = {
 *     startSession(typeId)      // 'wobble_ab' / 'dynamics_diff' / ...
 *     getQuestion()             // 現在の出題（{ id, choices, correct... }）
 *     submitAnswer(choice)      // 'a' | 'b' | 'unsure'
 *     getProgress()             // { typeId, currentIndex, total, correct, accuracy, byDifficulty }
 *     playClip(side)            // 'a' | 'b' を Tone.js で再生
 *     stopAudio()               // 進行中音源を停止
 *     getAvailableTypes()       // 5種定義一覧
 *     resetSession(typeId?)     // セッション破棄（typeId 指定で個別、無指定で全）
 *   }
 *
 * LS 統合：
 *   key: 'steady_ear_trainer_v3_2'
 *     {
 *       sessions: {
 *         wobble_ab:  { answers:[{id,choice,correct,ts}], currentIndex },
 *         dynamics_diff: {...},
 *         ...
 *       },
 *       lastTypeId: 'wobble_ab'
 *     }
 *
 * mp3 → Tone.js 合成への置換戦略：
 *   - 8 音 / 1 小節（4/4・bpm 可変）の simple 4-on-floor ドラム
 *   - 各 hit 時刻 = grid_t + (wobble_ms / 1000)（ランダム ±）
 *   - Kick = MembraneSynth、Snare = NoiseSynth、HiHat = MetalSynth
 *   - dynamics: triggerAttackRelease の velocity を 0.4-1.0 で散らす
 *   - timbre:   harmonicity / modulationIndex の差分
 *   - freq:     EQ3 で low/mid/high の差分
 *
 * 並列衝突回避：
 *   - 既存ファイル編集禁止 → steady-ear.html / steady-shared.js は触らない
 *   - shared.js LS_V32 への新キー追加は不可 → 独自 LS キーで運用
 *
 * grep PASS：直接アーティスト名 0 件・楽観バイアス 0 件・年齢露出 0 件
 * ============================================================ */
(function (global) {
  'use strict';

  // -------------------------------------------------------------
  // 0. 定数・LS キー
  // -------------------------------------------------------------
  var LS_KEY = 'steady_ear_trainer_v3_2';
  var TYPE_IDS = ['wobble_ab', 'dynamics_diff', 'timing_offset', 'timbre_nuance', 'freq_response'];

  function lsGet(k, fb) {
    try {
      var raw = localStorage.getItem(k);
      if (raw === null || raw === undefined) return fb;
      return JSON.parse(raw);
    } catch (_) { return fb; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; }
  }

  function loadStore() {
    var s = lsGet(LS_KEY, null);
    if (!s || typeof s !== 'object') {
      s = { sessions: {}, lastTypeId: null };
    }
    if (!s.sessions) s.sessions = {};
    return s;
  }
  function saveStore(s) { lsSet(LS_KEY, s); }

  function ensureSession(s, typeId) {
    if (!s.sessions[typeId]) {
      s.sessions[typeId] = { answers: [], currentIndex: 0 };
    }
    return s.sessions[typeId];
  }

  // -------------------------------------------------------------
  // 1. 質問プール構築
  //    B15a は spec 40 ペアをそのまま使用（wobble_ms_a/b → Tone.js offset）
  //    B15b-e は内部生成（30 ペア / each）
  // -------------------------------------------------------------

  // spec 40 ペアの埋め込みコピー（fetch 不要・並列衝突回避）
  // 出典：steady-ear-samples-spec.json（v3.2.0r2 / 2026-05-06）
  var SPEC_PAIRS_B15A = [
    { id: 'pair_01', difficulty: 'easy', bpm: 60,  pattern_base: 'p1_six_stroke',   tone: 'dry',  wobble_ms_a: 3,  wobble_ms_b: 28, correct_answer: 'a' },
    { id: 'pair_02', difficulty: 'easy', bpm: 80,  pattern_base: 'p3_half_time',    tone: 'room', wobble_ms_a: 32, wobble_ms_b: 5,  correct_answer: 'b' },
    { id: 'pair_03', difficulty: 'easy', bpm: 100, pattern_base: 'p2_sizzle_hat',   tone: 'dry',  wobble_ms_a: 4,  wobble_ms_b: 22, correct_answer: 'a' },
    { id: 'pair_04', difficulty: 'easy', bpm: 120, pattern_base: 'p1_six_stroke',   tone: 'lofi', wobble_ms_a: 30, wobble_ms_b: 6,  correct_answer: 'b' },
    { id: 'pair_05', difficulty: 'easy', bpm: 140, pattern_base: 'p6_crash_quarter', tone: 'dry', wobble_ms_a: 5,  wobble_ms_b: 25, correct_answer: 'a' },
    { id: 'pair_06', difficulty: 'easy', bpm: 160, pattern_base: 'p4_4bar_fills',   tone: 'room', wobble_ms_a: 26, wobble_ms_b: 4,  correct_answer: 'b' },
    { id: 'pair_07', difficulty: 'easy', bpm: 60,  pattern_base: 'p2_sizzle_hat',   tone: 'lofi', wobble_ms_a: 7,  wobble_ms_b: 35, correct_answer: 'a' },
    { id: 'pair_08', difficulty: 'easy', bpm: 80,  pattern_base: 'p5_octopus',      tone: 'dry',  wobble_ms_a: 31, wobble_ms_b: 8,  correct_answer: 'b' },
    { id: 'pair_09', difficulty: 'easy', bpm: 100, pattern_base: 'p3_half_time',    tone: 'room', wobble_ms_a: 6,  wobble_ms_b: 21, correct_answer: 'a' },
    { id: 'pair_10', difficulty: 'easy', bpm: 120, pattern_base: 'p4_4bar_fills',   tone: 'dry',  wobble_ms_a: 24, wobble_ms_b: 3,  correct_answer: 'b' },
    { id: 'pair_11', difficulty: 'easy', bpm: 140, pattern_base: 'p1_six_stroke',   tone: 'lofi', wobble_ms_a: 4,  wobble_ms_b: 27, correct_answer: 'a' },
    { id: 'pair_12', difficulty: 'easy', bpm: 160, pattern_base: 'p6_crash_quarter', tone: 'dry', wobble_ms_a: 33, wobble_ms_b: 7,  correct_answer: 'b' },
    { id: 'pair_13', difficulty: 'easy', bpm: 80,  pattern_base: 'p2_sizzle_hat',   tone: 'room', wobble_ms_a: 9,  wobble_ms_b: 34, correct_answer: 'a' },
    { id: 'pair_14', difficulty: 'easy', bpm: 100, pattern_base: 'p5_octopus',      tone: 'lofi', wobble_ms_a: 29, wobble_ms_b: 11, correct_answer: 'b' },

    { id: 'pair_15', difficulty: 'medium', bpm: 60,  pattern_base: 'p3_half_time',    tone: 'dry',  wobble_ms_a: 8,  wobble_ms_b: 21, correct_answer: 'a' },
    { id: 'pair_16', difficulty: 'medium', bpm: 80,  pattern_base: 'p1_six_stroke',   tone: 'room', wobble_ms_a: 19, wobble_ms_b: 7,  correct_answer: 'b' },
    { id: 'pair_17', difficulty: 'medium', bpm: 100, pattern_base: 'p6_crash_quarter', tone: 'lofi', wobble_ms_a: 6, wobble_ms_b: 17, correct_answer: 'a' },
    { id: 'pair_18', difficulty: 'medium', bpm: 120, pattern_base: 'p2_sizzle_hat',   tone: 'dry',  wobble_ms_a: 18, wobble_ms_b: 9,  correct_answer: 'b' },
    { id: 'pair_19', difficulty: 'medium', bpm: 140, pattern_base: 'p4_4bar_fills',   tone: 'room', wobble_ms_a: 5,  wobble_ms_b: 13, correct_answer: 'a' },
    { id: 'pair_20', difficulty: 'medium', bpm: 160, pattern_base: 'p5_octopus',      tone: 'lofi', wobble_ms_a: 15, wobble_ms_b: 8,  correct_answer: 'b' },
    { id: 'pair_21', difficulty: 'medium', bpm: 60,  pattern_base: 'p2_sizzle_hat',   tone: 'dry',  wobble_ms_a: 10, wobble_ms_b: 24, correct_answer: 'a' },
    { id: 'pair_22', difficulty: 'medium', bpm: 80,  pattern_base: 'p6_crash_quarter', tone: 'room', wobble_ms_a: 17, wobble_ms_b: 7, correct_answer: 'b' },
    { id: 'pair_23', difficulty: 'medium', bpm: 100, pattern_base: 'p1_six_stroke',   tone: 'dry',  wobble_ms_a: 4,  wobble_ms_b: 13, correct_answer: 'a' },
    { id: 'pair_24', difficulty: 'medium', bpm: 120, pattern_base: 'p3_half_time',    tone: 'lofi', wobble_ms_a: 16, wobble_ms_b: 10, correct_answer: 'b' },
    { id: 'pair_25', difficulty: 'medium', bpm: 140, pattern_base: 'p2_sizzle_hat',   tone: 'dry',  wobble_ms_a: 7,  wobble_ms_b: 18, correct_answer: 'a' },
    { id: 'pair_26', difficulty: 'medium', bpm: 160, pattern_base: 'p4_4bar_fills',   tone: 'room', wobble_ms_a: 14, wobble_ms_b: 6,  correct_answer: 'b' },
    { id: 'pair_27', difficulty: 'medium', bpm: 100, pattern_base: 'p5_octopus',      tone: 'dry',  wobble_ms_a: 8,  wobble_ms_b: 16, correct_answer: 'a' },

    { id: 'pair_28', difficulty: 'hard', bpm: 60,  pattern_base: 'p1_six_stroke',   tone: 'dry',  wobble_ms_a: 10, wobble_ms_b: 14, correct_answer: 'a' },
    { id: 'pair_29', difficulty: 'hard', bpm: 80,  pattern_base: 'p2_sizzle_hat',   tone: 'room', wobble_ms_a: 13, wobble_ms_b: 9,  correct_answer: 'b' },
    { id: 'pair_30', difficulty: 'hard', bpm: 100, pattern_base: 'p3_half_time',    tone: 'lofi', wobble_ms_a: 8,  wobble_ms_b: 12, correct_answer: 'a' },
    { id: 'pair_31', difficulty: 'hard', bpm: 120, pattern_base: 'p4_4bar_fills',   tone: 'dry',  wobble_ms_a: 11, wobble_ms_b: 8,  correct_answer: 'b' },
    { id: 'pair_32', difficulty: 'hard', bpm: 140, pattern_base: 'p5_octopus',      tone: 'room', wobble_ms_a: 6,  wobble_ms_b: 9,  correct_answer: 'a' },
    { id: 'pair_33', difficulty: 'hard', bpm: 160, pattern_base: 'p6_crash_quarter', tone: 'lofi', wobble_ms_a: 9, wobble_ms_b: 6,  correct_answer: 'b' },
    { id: 'pair_34', difficulty: 'hard', bpm: 60,  pattern_base: 'p3_half_time',    tone: 'dry',  wobble_ms_a: 13, wobble_ms_b: 17, correct_answer: 'a' },
    { id: 'pair_35', difficulty: 'hard', bpm: 80,  pattern_base: 'p4_4bar_fills',   tone: 'lofi', wobble_ms_a: 14, wobble_ms_b: 10, correct_answer: 'b' },
    { id: 'pair_36', difficulty: 'hard', bpm: 100, pattern_base: 'p2_sizzle_hat',   tone: 'dry',  wobble_ms_a: 7,  wobble_ms_b: 10, correct_answer: 'a' },
    { id: 'pair_37', difficulty: 'hard', bpm: 120, pattern_base: 'p1_six_stroke',   tone: 'room', wobble_ms_a: 13, wobble_ms_b: 11, correct_answer: 'b' },
    { id: 'pair_38', difficulty: 'hard', bpm: 140, pattern_base: 'p6_crash_quarter', tone: 'dry', wobble_ms_a: 5,  wobble_ms_b: 7,  correct_answer: 'a' },
    { id: 'pair_39', difficulty: 'hard', bpm: 160, pattern_base: 'p5_octopus',      tone: 'room', wobble_ms_a: 10, wobble_ms_b: 8,  correct_answer: 'b' },
    { id: 'pair_40', difficulty: 'hard', bpm: 80,  pattern_base: 'p3_half_time',    tone: 'lofi', wobble_ms_a: 9,  wobble_ms_b: 13, correct_answer: 'a' }
  ];

  // B15b: dynamics 差（dB）— A/B どちらが「強弱の差が大きい」か当てる
  // diff_db: A の hit 群 velocity 散らばり幅、B の hit 群 velocity 散らばり幅
  // correct = 「強弱差が大きい方」（演奏ダイナミクス検出力）
  function buildDynamicsPool() {
    var bpms = [60, 80, 100, 120, 140, 160];
    var pool = [];
    var configs = [
      // easy: dB 差 8-12（明確）
      { d: 'easy',   wide: 0.85, narrow: 0.10 },
      { d: 'easy',   wide: 0.80, narrow: 0.12 },
      { d: 'easy',   wide: 0.90, narrow: 0.08 },
      { d: 'easy',   wide: 0.82, narrow: 0.15 },
      { d: 'easy',   wide: 0.88, narrow: 0.10 },
      { d: 'easy',   wide: 0.78, narrow: 0.13 },
      { d: 'easy',   wide: 0.85, narrow: 0.11 },
      { d: 'easy',   wide: 0.80, narrow: 0.10 },
      { d: 'easy',   wide: 0.92, narrow: 0.14 },
      { d: 'easy',   wide: 0.83, narrow: 0.09 },
      // medium: dB 差 4-7
      { d: 'medium', wide: 0.70, narrow: 0.30 },
      { d: 'medium', wide: 0.65, narrow: 0.28 },
      { d: 'medium', wide: 0.72, narrow: 0.32 },
      { d: 'medium', wide: 0.68, narrow: 0.30 },
      { d: 'medium', wide: 0.75, narrow: 0.35 },
      { d: 'medium', wide: 0.66, narrow: 0.27 },
      { d: 'medium', wide: 0.70, narrow: 0.33 },
      { d: 'medium', wide: 0.73, narrow: 0.31 },
      { d: 'medium', wide: 0.69, narrow: 0.29 },
      { d: 'medium', wide: 0.71, narrow: 0.34 },
      // hard: dB 差 1-3
      { d: 'hard',   wide: 0.55, narrow: 0.40 },
      { d: 'hard',   wide: 0.52, narrow: 0.42 },
      { d: 'hard',   wide: 0.58, narrow: 0.45 },
      { d: 'hard',   wide: 0.54, narrow: 0.43 },
      { d: 'hard',   wide: 0.56, narrow: 0.44 },
      { d: 'hard',   wide: 0.53, narrow: 0.41 },
      { d: 'hard',   wide: 0.57, narrow: 0.46 },
      { d: 'hard',   wide: 0.55, narrow: 0.42 },
      { d: 'hard',   wide: 0.59, narrow: 0.47 },
      { d: 'hard',   wide: 0.51, narrow: 0.40 }
    ];
    for (var i = 0; i < configs.length; i++) {
      var c = configs[i];
      var aIsWide = (i % 2 === 0); // 偶数 i は A=wide
      pool.push({
        id: 'dyn_' + pad2(i + 1),
        difficulty: c.d,
        bpm: bpms[i % bpms.length],
        spread_a: aIsWide ? c.wide : c.narrow,
        spread_b: aIsWide ? c.narrow : c.wide,
        correct_answer: aIsWide ? 'a' : 'b'
      });
    }
    return pool;
  }

  // B15c: timing offset（前ノリ/後ノリ）— A/B どちらが「ジャスト基準」か
  // offset_ms_a/b: ハイハットを kick/snare に対し +/-N ms ずらす
  function buildTimingPool() {
    var pool = [];
    var configs = [
      // easy: 25-40ms（明確）
      { d: 'easy', a: 0,   b: 35 }, { d: 'easy', a: 30,  b: 0 },
      { d: 'easy', a: 0,   b: 28 }, { d: 'easy', a: 25,  b: 0 },
      { d: 'easy', a: 0,   b: 38 }, { d: 'easy', a: 32,  b: 0 },
      { d: 'easy', a: 0,   b: 27 }, { d: 'easy', a: 40,  b: 0 },
      { d: 'easy', a: 0,   b: 30 }, { d: 'easy', a: 26,  b: 0 },
      // medium: 12-20ms
      { d: 'medium', a: 0, b: 18 }, { d: 'medium', a: 15, b: 0 },
      { d: 'medium', a: 0, b: 14 }, { d: 'medium', a: 17, b: 0 },
      { d: 'medium', a: 0, b: 20 }, { d: 'medium', a: 13, b: 0 },
      { d: 'medium', a: 0, b: 16 }, { d: 'medium', a: 19, b: 0 },
      { d: 'medium', a: 0, b: 12 }, { d: 'medium', a: 18, b: 0 },
      // hard: 4-8ms
      { d: 'hard', a: 0, b: 6 }, { d: 'hard', a: 5, b: 0 },
      { d: 'hard', a: 0, b: 8 }, { d: 'hard', a: 7, b: 0 },
      { d: 'hard', a: 0, b: 5 }, { d: 'hard', a: 4, b: 0 },
      { d: 'hard', a: 0, b: 7 }, { d: 'hard', a: 6, b: 0 },
      { d: 'hard', a: 0, b: 4 }, { d: 'hard', a: 8, b: 0 }
    ];
    var bpms = [60, 80, 100, 120, 140, 160];
    for (var i = 0; i < configs.length; i++) {
      var c = configs[i];
      pool.push({
        id: 'tim_' + pad2(i + 1),
        difficulty: c.d,
        bpm: bpms[i % bpms.length],
        offset_ms_a: c.a,
        offset_ms_b: c.b,
        correct_answer: (Math.abs(c.a) < Math.abs(c.b)) ? 'a' : 'b'
      });
    }
    return pool;
  }

  // B15d: timbre nuance — Snare の harmonicity / modulation を変える
  // 「ニュアンスがある（変化に富む）方」を当てる
  function buildTimbrePool() {
    var pool = [];
    var bpms = [60, 80, 100, 120, 140, 160];
    var configs = [
      { d: 'easy',   varA: 0.05, varB: 0.55 }, { d: 'easy',   varA: 0.50, varB: 0.05 },
      { d: 'easy',   varA: 0.08, varB: 0.60 }, { d: 'easy',   varA: 0.58, varB: 0.07 },
      { d: 'easy',   varA: 0.04, varB: 0.52 }, { d: 'easy',   varA: 0.55, varB: 0.06 },
      { d: 'easy',   varA: 0.10, varB: 0.62 }, { d: 'easy',   varA: 0.50, varB: 0.05 },
      { d: 'easy',   varA: 0.06, varB: 0.58 }, { d: 'easy',   varA: 0.60, varB: 0.08 },
      { d: 'medium', varA: 0.18, varB: 0.42 }, { d: 'medium', varA: 0.40, varB: 0.18 },
      { d: 'medium', varA: 0.20, varB: 0.45 }, { d: 'medium', varA: 0.43, varB: 0.20 },
      { d: 'medium', varA: 0.22, varB: 0.46 }, { d: 'medium', varA: 0.42, varB: 0.22 },
      { d: 'medium', varA: 0.19, varB: 0.41 }, { d: 'medium', varA: 0.44, varB: 0.21 },
      { d: 'medium', varA: 0.23, varB: 0.45 }, { d: 'medium', varA: 0.40, varB: 0.20 },
      { d: 'hard',   varA: 0.30, varB: 0.36 }, { d: 'hard',   varA: 0.35, varB: 0.30 },
      { d: 'hard',   varA: 0.31, varB: 0.37 }, { d: 'hard',   varA: 0.36, varB: 0.31 },
      { d: 'hard',   varA: 0.32, varB: 0.37 }, { d: 'hard',   varA: 0.35, varB: 0.30 },
      { d: 'hard',   varA: 0.30, varB: 0.35 }, { d: 'hard',   varA: 0.36, varB: 0.31 },
      { d: 'hard',   varA: 0.33, varB: 0.38 }, { d: 'hard',   varA: 0.37, varB: 0.32 }
    ];
    for (var i = 0; i < configs.length; i++) {
      var c = configs[i];
      pool.push({
        id: 'tmb_' + pad2(i + 1),
        difficulty: c.d,
        bpm: bpms[i % bpms.length],
        timbre_var_a: c.varA,
        timbre_var_b: c.varB,
        correct_answer: (c.varA > c.varB) ? 'a' : 'b'
      });
    }
    return pool;
  }

  // B15e: freq response — EQ3 の low/mid/high gain を変えて A/B 比較
  // 「より低音がブースト/ハイがブースト」など方向性を当てる
  // ここでは「より高域がブーストされている方」を出題
  function buildFreqPool() {
    var pool = [];
    var bpms = [60, 80, 100, 120, 140, 160];
    var configs = [
      // easy: dB 差 ±9〜±12
      { d: 'easy', highA: -10, highB: 2 }, { d: 'easy', highA: 3,   highB: -10 },
      { d: 'easy', highA: -8,  highB: 4 }, { d: 'easy', highA: 5,   highB: -9 },
      { d: 'easy', highA: -12, highB: 0 }, { d: 'easy', highA: 0,   highB: -11 },
      { d: 'easy', highA: -7,  highB: 5 }, { d: 'easy', highA: 6,   highB: -8 },
      { d: 'easy', highA: -9,  highB: 3 }, { d: 'easy', highA: 4,   highB: -10 },
      // medium: dB 差 ±4〜±6
      { d: 'medium', highA: -3, highB: 3 }, { d: 'medium', highA: 4, highB: -2 },
      { d: 'medium', highA: -4, highB: 2 }, { d: 'medium', highA: 3, highB: -4 },
      { d: 'medium', highA: -2, highB: 4 }, { d: 'medium', highA: 5, highB: -1 },
      { d: 'medium', highA: -3, highB: 3 }, { d: 'medium', highA: 4, highB: -2 },
      { d: 'medium', highA: -5, highB: 1 }, { d: 'medium', highA: 2, highB: -4 },
      // hard: dB 差 ±1〜±2
      { d: 'hard', highA: -1, highB: 1 }, { d: 'hard', highA: 2,  highB: 0 },
      { d: 'hard', highA: 0,  highB: 2 }, { d: 'hard', highA: 1,  highB: -1 },
      { d: 'hard', highA: -1, highB: 1 }, { d: 'hard', highA: 2,  highB: 0 },
      { d: 'hard', highA: 0,  highB: 2 }, { d: 'hard', highA: 1,  highB: -1 },
      { d: 'hard', highA: -2, highB: 0 }, { d: 'hard', highA: 1,  highB: -1 }
    ];
    for (var i = 0; i < configs.length; i++) {
      var c = configs[i];
      pool.push({
        id: 'frq_' + pad2(i + 1),
        difficulty: c.d,
        bpm: bpms[i % bpms.length],
        eq_high_a: c.highA,
        eq_high_b: c.highB,
        correct_answer: (c.highA > c.highB) ? 'a' : 'b' // 高域が高い方
      });
    }
    return pool;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // -------------------------------------------------------------
  // 2. 5種定義レジストリ
  // -------------------------------------------------------------
  var TYPE_REGISTRY = {
    wobble_ab: {
      id: 'wobble_ab',
      label: '微妙な揺らぎ A/B 比較',
      description: '2つの音源を聴き、揺らぎ（タイミング揺れ）が小さい方を選ぶ',
      pool: SPEC_PAIRS_B15A,
      synthesizer: synthesizeWobble,
      uiHint: '揺らぎが少ない（安定している）方を選んでください'
    },
    dynamics_diff: {
      id: 'dynamics_diff',
      label: '強弱（ダイナミクス）差',
      description: '2つの音源のうち、強弱の差（ダイナミクスレンジ）が広い方を選ぶ',
      pool: buildDynamicsPool(),
      synthesizer: synthesizeDynamics,
      uiHint: '強弱の差（メリハリ）が大きい方を選んでください'
    },
    timing_offset: {
      id: 'timing_offset',
      label: 'タイミングずれ検出',
      description: '2つの音源のうち、ハイハットのタイミングがジャストに近い方を選ぶ',
      pool: buildTimingPool(),
      synthesizer: synthesizeTimingOffset,
      uiHint: 'タイミングがジャスト（前後ノリしていない）方を選んでください'
    },
    timbre_nuance: {
      id: 'timbre_nuance',
      label: '音色ニュアンス',
      description: '2つの音源のうち、音色のニュアンス（変化）が豊かな方を選ぶ',
      pool: buildTimbrePool(),
      synthesizer: synthesizeTimbre,
      uiHint: '音色のニュアンス（質感の変化）が豊かな方を選んでください'
    },
    freq_response: {
      id: 'freq_response',
      label: '周波数特性',
      description: '2つの音源のうち、高域がより強調されている方を選ぶ',
      pool: buildFreqPool(),
      synthesizer: synthesizeFreq,
      uiHint: '高域（シンバル/ハイハット）がより明るい方を選んでください'
    }
  };

  // -------------------------------------------------------------
  // 3. Tone.js 合成エンジン
  // -------------------------------------------------------------

  // アクティブな音源・スケジュールの追跡（停止用）
  var _activeNodes = [];
  var _activeTimers = [];

  function ensureToneRunning() {
    if (typeof Tone === 'undefined' || !Tone) {
      throw new Error('Tone.js is not loaded.');
    }
    if (Tone.context && Tone.context.state !== 'running') {
      try { Tone.start && Tone.start(); } catch (_) { /* ignore */ }
    }
  }

  function disposeAll() {
    for (var i = 0; i < _activeNodes.length; i++) {
      try { _activeNodes[i].dispose && _activeNodes[i].dispose(); } catch (_) {}
    }
    _activeNodes = [];
    for (var j = 0; j < _activeTimers.length; j++) {
      try { clearTimeout(_activeTimers[j]); } catch (_) {}
    }
    _activeTimers = [];
  }

  function track(node) { _activeNodes.push(node); return node; }

  // 共通：4/4 1 小節の hit grid（kick/snare/hihat × 8 hits）
  // bpm から各 16 分音符の時刻を計算
  function buildBeatGrid(bpm, bars) {
    bars = bars || 2;
    var sec_per_beat = 60 / bpm;
    var grid = []; // { t, type:'kick'|'snare'|'hihat' }
    for (var b = 0; b < bars; b++) {
      var bar_start = b * 4 * sec_per_beat;
      // 4 on the floor kick + 2/4 backbeat snare + 8 分 hihat
      for (var beat = 0; beat < 4; beat++) {
        grid.push({ t: bar_start + beat * sec_per_beat, type: 'kick' });
        if (beat % 2 === 1) {
          grid.push({ t: bar_start + beat * sec_per_beat, type: 'snare' });
        }
      }
      for (var k = 0; k < 8; k++) {
        grid.push({ t: bar_start + k * (sec_per_beat / 2), type: 'hihat' });
      }
    }
    return grid;
  }

  // wobble_ms をランダム ±方向にずらす（疑似ランダム・seed なし簡易）
  function applyWobble(t, wobble_ms) {
    if (!wobble_ms) return t;
    var ms = wobble_ms * (Math.random() * 2 - 1);
    return t + ms / 1000;
  }

  // synth ファクトリ
  function makeKick() {
    return track(new Tone.MembraneSynth({
      pitchDecay: 0.05, octaves: 6,
      envelope: { attack: 0.001, decay: 0.4, sustain: 0.01, release: 1.4, attackCurve: 'exponential' }
    }));
  }
  function makeSnare(harmonicity) {
    var s = track(new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.13, sustain: 0 }
    }));
    if (harmonicity != null) {
      // NoiseSynth に harmonicity は無いので Filter で代用
      var filt = track(new Tone.Filter(2000 + harmonicity * 3000, 'highpass'));
      s.connect(filt);
      return { trigger: function (t, vel) { s.triggerAttackRelease('16n', t, vel); }, output: filt };
    }
    return { trigger: function (t, vel) { s.triggerAttackRelease('16n', t, vel); }, output: s };
  }
  function makeHiHat() {
    return track(new Tone.MetalSynth({
      frequency: 250, envelope: { attack: 0.001, decay: 0.1, release: 0.01 },
      harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5
    }));
  }

  // ---- B15a wobble 合成 ----
  function synthesizeWobble(pair, side) {
    ensureToneRunning();
    disposeAll();
    var wobble = (side === 'a') ? pair.wobble_ms_a : pair.wobble_ms_b;
    var bpm = pair.bpm || 100;
    var grid = buildBeatGrid(bpm, 2);

    // tone カラー（dry/room/lofi）→ Reverb / Filter で軽く色付け
    var output = applyToneColor(pair.tone);

    var kick = makeKick().connect(output);
    var snare = makeSnare();
    snare.output.connect(output);
    var hh = makeHiHat().connect(output);

    var now = Tone.now() + 0.1;
    grid.forEach(function (g) {
      var t = applyWobble(now + g.t, wobble);
      try {
        if (g.type === 'kick') kick.triggerAttackRelease('C2', '8n', t, 0.95);
        else if (g.type === 'snare') snare.trigger(t, 0.85);
        else if (g.type === 'hihat') hh.triggerAttackRelease('16n', t, 0.45);
      } catch (_) {}
    });

    // 自動 dispose（再生終了想定 sec_per_beat * 8 + 余裕）
    var dur_ms = (60 / bpm) * 4 * 2 * 1000 + 800;
    _activeTimers.push(setTimeout(disposeAll, dur_ms));
    return dur_ms;
  }

  // ---- B15b dynamics 合成 ----
  function synthesizeDynamics(pair, side) {
    ensureToneRunning();
    disposeAll();
    var spread = (side === 'a') ? pair.spread_a : pair.spread_b;
    var bpm = pair.bpm || 100;
    var grid = buildBeatGrid(bpm, 2);

    var output = applyToneColor('dry');
    var kick = makeKick().connect(output);
    var snare = makeSnare();
    snare.output.connect(output);
    var hh = makeHiHat().connect(output);

    var now = Tone.now() + 0.1;
    var baseVel = 0.5;
    grid.forEach(function (g, i) {
      // velocity を spread の幅で散らす（spread 大→velocity ばらつき大）
      var rand = Math.random() * 2 - 1; // -1..1
      var vel = clamp(baseVel + rand * spread, 0.05, 1.0);
      var t = now + g.t;
      try {
        if (g.type === 'kick') kick.triggerAttackRelease('C2', '8n', t, vel);
        else if (g.type === 'snare') snare.trigger(t, vel);
        else if (g.type === 'hihat') hh.triggerAttackRelease('16n', t, clamp(vel * 0.6, 0.05, 0.7));
      } catch (_) {}
    });

    var dur_ms = (60 / bpm) * 4 * 2 * 1000 + 800;
    _activeTimers.push(setTimeout(disposeAll, dur_ms));
    return dur_ms;
  }

  // ---- B15c timing offset 合成 ----
  function synthesizeTimingOffset(pair, side) {
    ensureToneRunning();
    disposeAll();
    var offset_ms = (side === 'a') ? pair.offset_ms_a : pair.offset_ms_b;
    var bpm = pair.bpm || 100;
    var grid = buildBeatGrid(bpm, 2);

    var output = applyToneColor('dry');
    var kick = makeKick().connect(output);
    var snare = makeSnare();
    snare.output.connect(output);
    var hh = makeHiHat().connect(output);

    var now = Tone.now() + 0.1;
    grid.forEach(function (g) {
      // hihat だけを offset_ms ずらす
      var t = now + g.t;
      if (g.type === 'hihat') t += offset_ms / 1000;
      try {
        if (g.type === 'kick') kick.triggerAttackRelease('C2', '8n', t, 0.95);
        else if (g.type === 'snare') snare.trigger(t, 0.85);
        else if (g.type === 'hihat') hh.triggerAttackRelease('16n', t, 0.45);
      } catch (_) {}
    });

    var dur_ms = (60 / bpm) * 4 * 2 * 1000 + 800;
    _activeTimers.push(setTimeout(disposeAll, dur_ms));
    return dur_ms;
  }

  // ---- B15d timbre nuance 合成 ----
  function synthesizeTimbre(pair, side) {
    ensureToneRunning();
    disposeAll();
    var variance = (side === 'a') ? pair.timbre_var_a : pair.timbre_var_b;
    var bpm = pair.bpm || 100;
    var grid = buildBeatGrid(bpm, 2);

    var output = applyToneColor('dry');
    var kick = makeKick().connect(output);
    var hh_base = makeHiHat();
    hh_base.connect(output);

    // snare は毎 hit で harmonicity を変える（variance 大→ニュアンス大）
    var now = Tone.now() + 0.1;
    grid.forEach(function (g) {
      var t = now + g.t;
      try {
        if (g.type === 'kick') kick.triggerAttackRelease('C2', '8n', t, 0.95);
        else if (g.type === 'snare') {
          // snare を毎回作り直して harmonicity 散らす（コスト高だが許容）
          var randH = Math.random() * variance;
          var s = makeSnare(randH);
          s.output.connect(output);
          s.trigger(t, 0.85);
        } else if (g.type === 'hihat') {
          hh_base.triggerAttackRelease('16n', t, 0.45);
        }
      } catch (_) {}
    });

    var dur_ms = (60 / bpm) * 4 * 2 * 1000 + 800;
    _activeTimers.push(setTimeout(disposeAll, dur_ms));
    return dur_ms;
  }

  // ---- B15e freq response 合成 ----
  function synthesizeFreq(pair, side) {
    ensureToneRunning();
    disposeAll();
    var highGain = (side === 'a') ? pair.eq_high_a : pair.eq_high_b;
    var bpm = pair.bpm || 100;
    var grid = buildBeatGrid(bpm, 2);

    // EQ3 で high band を gain 調整
    var eq = track(new Tone.EQ3({ low: 0, mid: 0, high: highGain }));
    eq.toDestination();

    var kick = makeKick().connect(eq);
    var snare = makeSnare();
    snare.output.connect(eq);
    var hh = makeHiHat().connect(eq);

    var now = Tone.now() + 0.1;
    grid.forEach(function (g) {
      var t = now + g.t;
      try {
        if (g.type === 'kick') kick.triggerAttackRelease('C2', '8n', t, 0.95);
        else if (g.type === 'snare') snare.trigger(t, 0.85);
        else if (g.type === 'hihat') hh.triggerAttackRelease('16n', t, 0.55);
      } catch (_) {}
    });

    var dur_ms = (60 / bpm) * 4 * 2 * 1000 + 800;
    _activeTimers.push(setTimeout(disposeAll, dur_ms));
    return dur_ms;
  }

  // tone カラー（dry/room/lofi）の出力チェーン
  function applyToneColor(toneName) {
    if (toneName === 'room') {
      var rev = track(new Tone.Reverb({ decay: 1.2, wet: 0.25 }));
      rev.toDestination();
      return rev;
    }
    if (toneName === 'lofi') {
      var lpf = track(new Tone.Filter(3500, 'lowpass'));
      var crusher = track(new Tone.BitCrusher(6));
      lpf.connect(crusher);
      crusher.toDestination();
      return lpf;
    }
    // dry
    var dry = track(new Tone.Gain(0.9));
    dry.toDestination();
    return dry;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // -------------------------------------------------------------
  // 4. セッション管理 / 公開 API
  // -------------------------------------------------------------
  var _current = {
    typeId: null,
    pair: null
  };

  function startSession(typeId) {
    if (!TYPE_REGISTRY[typeId]) {
      throw new Error('Unknown ear-trainer typeId: ' + typeId);
    }
    var store = loadStore();
    store.lastTypeId = typeId;
    var sess = ensureSession(store, typeId);
    saveStore(store);
    _current.typeId = typeId;
    _current.pair = pickQuestion(typeId, sess);
    return {
      typeId: typeId,
      total: TYPE_REGISTRY[typeId].pool.length,
      currentIndex: sess.currentIndex,
      label: TYPE_REGISTRY[typeId].label
    };
  }

  function pickQuestion(typeId, sess) {
    var pool = TYPE_REGISTRY[typeId].pool;
    if (sess.currentIndex >= pool.length) {
      return null; // 全問完了
    }
    return pool[sess.currentIndex];
  }

  function getQuestion() {
    if (!_current.typeId) return null;
    var store = loadStore();
    var sess = ensureSession(store, _current.typeId);
    var pair = pickQuestion(_current.typeId, sess);
    _current.pair = pair;
    if (!pair) {
      return { done: true, typeId: _current.typeId, summary: getProgress() };
    }
    return {
      done: false,
      typeId: _current.typeId,
      id: pair.id,
      difficulty: pair.difficulty,
      bpm: pair.bpm,
      uiHint: TYPE_REGISTRY[_current.typeId].uiHint,
      // correct_answer は外に出さない（不正検出のため）
      currentIndex: sess.currentIndex,
      total: TYPE_REGISTRY[_current.typeId].pool.length
    };
  }

  function submitAnswer(choice) {
    if (!_current.typeId || !_current.pair) {
      return { ok: false, reason: 'no-session' };
    }
    if (choice !== 'a' && choice !== 'b' && choice !== 'unsure') {
      return { ok: false, reason: 'invalid-choice' };
    }
    var pair = _current.pair;
    var correct = (choice === pair.correct_answer);
    var store = loadStore();
    var sess = ensureSession(store, _current.typeId);
    sess.answers.push({
      id: pair.id,
      difficulty: pair.difficulty,
      choice: choice,
      correct: correct,
      ts: Date.now()
    });
    sess.currentIndex += 1;
    saveStore(store);
    var nextPair = pickQuestion(_current.typeId, sess);
    _current.pair = nextPair;
    return {
      ok: true,
      correct: correct,
      correctAnswer: pair.correct_answer,
      done: !nextPair,
      progress: getProgress()
    };
  }

  function getProgress(typeId) {
    var t = typeId || _current.typeId;
    if (!t) return null;
    var store = loadStore();
    var sess = ensureSession(store, t);
    var total = TYPE_REGISTRY[t].pool.length;
    var correct = 0;
    var byDifficulty = { easy: { total: 0, correct: 0 }, medium: { total: 0, correct: 0 }, hard: { total: 0, correct: 0 } };
    for (var i = 0; i < sess.answers.length; i++) {
      var a = sess.answers[i];
      if (a.correct) correct += 1;
      if (byDifficulty[a.difficulty]) {
        byDifficulty[a.difficulty].total += 1;
        if (a.correct) byDifficulty[a.difficulty].correct += 1;
      }
    }
    return {
      typeId: t,
      label: TYPE_REGISTRY[t].label,
      total: total,
      currentIndex: sess.currentIndex,
      answered: sess.answers.length,
      correct: correct,
      accuracy: sess.answers.length > 0 ? (correct / sess.answers.length) : 0,
      byDifficulty: byDifficulty,
      done: sess.currentIndex >= total
    };
  }

  function playClip(side) {
    if (!_current.typeId || !_current.pair) return { ok: false, reason: 'no-question' };
    if (side !== 'a' && side !== 'b') return { ok: false, reason: 'invalid-side' };
    var def = TYPE_REGISTRY[_current.typeId];
    try {
      var dur_ms = def.synthesizer(_current.pair, side);
      return { ok: true, durationMs: dur_ms };
    } catch (e) {
      return { ok: false, reason: 'synth-error', error: e.message };
    }
  }

  function stopAudio() {
    disposeAll();
    return { ok: true };
  }

  function getAvailableTypes() {
    return TYPE_IDS.map(function (id) {
      var d = TYPE_REGISTRY[id];
      return {
        id: d.id,
        label: d.label,
        description: d.description,
        poolSize: d.pool.length
      };
    });
  }

  function resetSession(typeId) {
    var store = loadStore();
    if (typeId) {
      delete store.sessions[typeId];
      if (_current.typeId === typeId) {
        _current.typeId = null;
        _current.pair = null;
      }
    } else {
      store.sessions = {};
      _current.typeId = null;
      _current.pair = null;
    }
    saveStore(store);
    return { ok: true };
  }

  // -------------------------------------------------------------
  // 5. 公開
  // -------------------------------------------------------------
  global.SteadyEarTrainer = {
    // セッション制御
    startSession: startSession,
    getQuestion: getQuestion,
    submitAnswer: submitAnswer,
    getProgress: getProgress,
    resetSession: resetSession,
    getAvailableTypes: getAvailableTypes,
    // 音声制御
    playClip: playClip,
    stopAudio: stopAudio,
    // メタ情報（デバッグ用）
    _LS_KEY: LS_KEY,
    _TYPE_REGISTRY_KEYS: TYPE_IDS,
    _VERSION: 'v3.2.0r2-B15a-e-2026-05-06-AL007p6'
  };
})(typeof window !== 'undefined' ? window : this);
