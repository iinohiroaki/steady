/* =============================================================
   STEADY v3.2.0r2-block8-h2 — steady-use-log.js（P13 SteadyUseLog 機構）
   発注書：00_社内システム/06_AI運用台帳/発注書/2026-05-06_AL007_steady_v3.2.0r2_P13_SteadyUseLog.md
   親監査：00_社内システム/06_AI運用台帳/監査ログ/2026-05-06_EMP002_全体設計pre-audit.md §2-13 P13

   目的：
     EMP002 PRE-AUDIT §2-13 で「致命」指摘された P13 SteadyUseLog 機構の独立 module 実装。
     試用フロー設計書 §4-1 観察項目（連続使用日数・録音回数・8 patterns 進捗・FB 件数）の
     物理化。ABSOLUTE RULE 11（broken-promise 防止）の解消。

   設計原則：
     - 単一 IIFE で window.SteadyUseLog のみ公開
     - 衝突回避ガード（既存 SteadyUseLog があれば return）
     - localStorage キーは _v3_2 名前空間（steady_use_log_v3_2）
     - pattern 個別 LS には触らない（既存破壊リスクゼロ）
     - 自動 startSession（DOMContentLoaded）/ 自動 endSession（beforeunload + pagehide）

   公開 API（発注書 §3 通り）：
     window.SteadyUseLog = {
       __version,
       startSession(), endSession(),
       recordPatternUse(pattern_id),
       getStreakDays(),
       getDailyUseCount(daysBack),
       getSummary(),
       getState()
     };

   範囲外（発注書 §6 明示）：
     - emolab-*.js への recordPatternUse hook 挿入（後続 dispatch）
     - getSummary() の UI 表示 HTML（後続 dispatch）
     - IDB recordings 件数の Promise 統合の細部（fire-and-forget で受ける）
   ============================================================= */

(function (global) {
  'use strict';

  // -------------------------------------------------------------
  // 0. 衝突回避ガード（並列 dispatch 互換）
  // -------------------------------------------------------------
  if (global.SteadyUseLog && global.SteadyUseLog.__version) {
    if (global.STEADY_DEBUG) console.warn('[steady-use-log] already loaded:', global.SteadyUseLog.__version);
    return;
  }

  // -------------------------------------------------------------
  // 1. 定数
  // -------------------------------------------------------------
  var LS_KEY = 'steady_use_log_v3_2';
  var SCHEMA_VERSION = 1;
  var MAX_SESSIONS = 60; // 直近 60 日分

  // -------------------------------------------------------------
  // 2. localStorage 安全ラッパ（steady-shared.js があればそちらを優先）
  // -------------------------------------------------------------
  function lsGet(key, fallback) {
    try {
      if (global.SteadyShared && typeof global.SteadyShared.lsGet === 'function') {
        return global.SteadyShared.lsGet(key, fallback);
      }
      var raw = localStorage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch (_) { return fallback; }
  }
  function lsSet(key, value) {
    try {
      if (global.SteadyShared && typeof global.SteadyShared.lsSet === 'function') {
        return global.SteadyShared.lsSet(key, value);
      }
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) { return false; }
  }

  // -------------------------------------------------------------
  // 3. 日付ユーティリティ（現地タイムゾーン基準）
  // -------------------------------------------------------------
  function ymd(date) {
    var d = (date instanceof Date) ? date : new Date(date);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  }
  function todayYMD() { return ymd(new Date()); }
  function yesterdayYMD() {
    var d = new Date();
    d.setDate(d.getDate() - 1);
    return ymd(d);
  }
  function daysAgoYMD(daysBack) {
    var d = new Date();
    d.setDate(d.getDate() - daysBack);
    return ymd(d);
  }

  // -------------------------------------------------------------
  // 4. state ロード／セーブ（localStorage を真実とする）
  // -------------------------------------------------------------
  function loadState() {
    var s = lsGet(LS_KEY, null);
    if (!s || typeof s !== 'object') {
      return defaultState();
    }
    // 互換性確保：欠損フィールドは default で補完
    if (typeof s.schema_version !== 'number') s.schema_version = SCHEMA_VERSION;
    if (typeof s.firstUsedAt === 'undefined') s.firstUsedAt = null;
    if (typeof s.lastSessionDate === 'undefined') s.lastSessionDate = null;
    if (typeof s.streakDays !== 'number') s.streakDays = 0;
    if (typeof s.totalSessionsCount !== 'number') s.totalSessionsCount = 0;
    if (!Array.isArray(s.sessions)) s.sessions = [];
    return s;
  }
  function defaultState() {
    return {
      schema_version: SCHEMA_VERSION,
      firstUsedAt: null,
      lastSessionDate: null,
      streakDays: 0,
      totalSessionsCount: 0,
      sessions: []
    };
  }
  function saveState(s) {
    return lsSet(LS_KEY, s);
  }

  // -------------------------------------------------------------
  // 5. 内部セッション状態（メモリ上・LS 反映は flush 時）
  // -------------------------------------------------------------
  var current = {
    active: false,
    startedAt: 0,
    date: null,           // YYYY-MM-DD
    patternsUsed: {}      // { p1:true, p3:true } map（重複排除）
  };

  // -------------------------------------------------------------
  // 6. sessions[] への集約 helper
  //    同日 date エントリがあれば patterns_used ユニオン・duration_ms 加算・endedAt 更新
  // -------------------------------------------------------------
  function upsertSession(state, entry) {
    // entry: { date, startedAt, endedAt, duration_ms, patterns_used: [...] }
    var sessions = state.sessions || [];
    var idx = -1;
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i] && sessions[i].date === entry.date) { idx = i; break; }
    }
    if (idx === -1) {
      sessions.push({
        date: entry.date,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        duration_ms: entry.duration_ms,
        patterns_used: (entry.patterns_used || []).slice()
      });
    } else {
      var existing = sessions[idx];
      // patterns_used ユニオン
      var setMap = {};
      (existing.patterns_used || []).forEach(function (p) { setMap[p] = true; });
      (entry.patterns_used || []).forEach(function (p) { setMap[p] = true; });
      existing.patterns_used = Object.keys(setMap);
      // duration_ms 加算（負値は無視）
      if (typeof entry.duration_ms === 'number' && entry.duration_ms > 0) {
        existing.duration_ms = (existing.duration_ms || 0) + entry.duration_ms;
      }
      // endedAt は新しい方を採用
      if (typeof entry.endedAt === 'number' && entry.endedAt > (existing.endedAt || 0)) {
        existing.endedAt = entry.endedAt;
      }
      // startedAt は古い方を保持（最初の session 開始時刻）
      if (typeof entry.startedAt === 'number' && entry.startedAt > 0) {
        if (!existing.startedAt || entry.startedAt < existing.startedAt) {
          existing.startedAt = entry.startedAt;
        }
      }
    }
    // max 60 entries（古いものは shift）
    while (sessions.length > MAX_SESSIONS) {
      sessions.shift();
    }
    state.sessions = sessions;
    return state;
  }

  // -------------------------------------------------------------
  // 7. startSession（発注書 §2-3 streakDays 更新ロジック厳守）
  // -------------------------------------------------------------
  function startSession() {
    if (current.active) {
      // 既にアクティブ → 二重起動は無視（patterns_used は recordPatternUse で蓄積継続）
      return;
    }
    var state = loadState();
    var now = Date.now();
    var today = todayYMD();
    var yesterday = yesterdayYMD();

    // firstUsedAt は一度だけ書く
    if (state.firstUsedAt === null || typeof state.firstUsedAt !== 'number') {
      state.firstUsedAt = now;
    }

    // streakDays 更新ロジック（発注書 §2-3 厳守）
    if (state.lastSessionDate === today) {
      // 同日再起動 → 既存 session に集約・streakDays 不変
    } else if (state.lastSessionDate === yesterday) {
      state.streakDays = (state.streakDays || 0) + 1;
    } else {
      state.streakDays = 1;
    }
    state.lastSessionDate = today;

    // totalSessionsCount は同日再起動でもインクリメントしない（暦日 1 セッション原則）
    var isNewDay = !sessionExistsForDate(state, today);
    if (isNewDay) {
      state.totalSessionsCount = (state.totalSessionsCount || 0) + 1;
    }

    // 内部 session 状態を初期化（開始時刻はメモリのみ）
    current.active = true;
    current.startedAt = now;
    current.date = today;
    current.patternsUsed = {};

    // sessions[] に skeleton を登録（duration_ms=0・endedAt=startedAt）
    upsertSession(state, {
      date: today,
      startedAt: now,
      endedAt: now,
      duration_ms: 0,
      patterns_used: []
    });

    saveState(state);
  }

  function sessionExistsForDate(state, date) {
    var sessions = state.sessions || [];
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i] && sessions[i].date === date) return true;
    }
    return false;
  }

  // -------------------------------------------------------------
  // 8. endSession（beforeunload / pagehide で呼ぶ・冪等）
  // -------------------------------------------------------------
  function endSession() {
    if (!current.active) return;
    var state = loadState();
    var now = Date.now();
    var duration = Math.max(0, now - (current.startedAt || now));
    var patterns = Object.keys(current.patternsUsed || {});

    upsertSession(state, {
      date: current.date || todayYMD(),
      startedAt: current.startedAt || now,
      endedAt: now,
      duration_ms: duration,
      patterns_used: patterns
    });

    saveState(state);

    // 内部 session 状態をリセット（多重 endSession 防止）
    current.active = false;
    current.startedAt = 0;
    current.date = null;
    current.patternsUsed = {};
  }

  // -------------------------------------------------------------
  // 9. recordPatternUse（emolab 各 startPx() から呼ばれる想定・本 dispatch では公開のみ）
  //    引数：'p1'..'p8'。重複は OK（patterns_used がユニオンで持つ）
  // -------------------------------------------------------------
  function recordPatternUse(pattern_id) {
    if (typeof pattern_id !== 'string' || !/^p[1-8]$/.test(pattern_id)) {
      return false;
    }
    if (!current.active) {
      // 未起動なら自動起動（保険）
      startSession();
    }
    current.patternsUsed[pattern_id] = true;

    // LS への即時反映（タブ閉じが早い場合の保護）
    var state = loadState();
    upsertSession(state, {
      date: current.date || todayYMD(),
      startedAt: current.startedAt || Date.now(),
      endedAt: Date.now(),
      duration_ms: 0, // duration は endSession で集計
      patterns_used: [pattern_id]
    });
    saveState(state);
    return true;
  }

  // -------------------------------------------------------------
  // 10. クエリ系 API
  // -------------------------------------------------------------
  function getStreakDays() {
    var state = loadState();
    // 当日も前日も lastSessionDate に該当しなければ、streak は切れている
    var today = todayYMD();
    var yesterday = yesterdayYMD();
    if (state.lastSessionDate === today || state.lastSessionDate === yesterday) {
      return state.streakDays || 0;
    }
    // streak 切れ（startSession 呼出前の参照時点）
    return 0;
  }

  function getDailyUseCount(daysBack) {
    var n = (typeof daysBack === 'number' && daysBack > 0) ? Math.floor(daysBack) : 7;
    var state = loadState();
    var sessions = state.sessions || [];
    // date → entry index map
    var byDate = {};
    sessions.forEach(function (s) {
      if (s && s.date) byDate[s.date] = s;
    });
    var result = [];
    for (var i = n - 1; i >= 0; i--) {
      var d = daysAgoYMD(i);
      var entry = byDate[d];
      if (entry) {
        result.push({
          date: d,
          count: 1, // 暦日 1 セッション原則（同日複数起動でも 1 にまとめる）
          patterns: (entry.patterns_used || []).slice(),
          duration_ms: entry.duration_ms || 0
        });
      } else {
        result.push({ date: d, count: 0, patterns: [], duration_ms: 0 });
      }
    }
    return result;
  }

  function getSummary() {
    var state = loadState();
    // PHASE1_PROGRESS は steady-shared.js LS_V32 経由（参照のみ）
    var phase1 = null;
    try {
      if (global.SteadyShared && global.SteadyShared.LS_V32 && global.SteadyShared.LS_V32.PHASE1_PROGRESS) {
        phase1 = lsGet(global.SteadyShared.LS_V32.PHASE1_PROGRESS, null);
      }
    } catch (_) {}

    // recordingsCount（IDB 集約・Promise）— SteadyRecorder.listRecordings が利用可能なら呼ぶ
    var recordingsCountPromise = null;
    try {
      if (global.SteadyRecorder && typeof global.SteadyRecorder.listRecordings === 'function') {
        recordingsCountPromise = global.SteadyRecorder.listRecordings()
          .then(function (list) { return Array.isArray(list) ? list.length : 0; })
          .catch(function () { return null; });
      }
    } catch (_) {}

    return {
      firstUsedAt: state.firstUsedAt,
      streakDays: getStreakDays(),
      totalSessionsCount: state.totalSessionsCount || 0,
      lastSessionDate: state.lastSessionDate,
      // 同期：recordingsCountPromise（呼出側で await or .then 推奨）
      // 非同期不要なら null（fire-and-forget）
      recordingsCountPromise: recordingsCountPromise,
      phase1Progress: phase1,
      sessionsLast7Days: getDailyUseCount(7),
      sessionsLast14Days: getDailyUseCount(14)
    };
  }

  function getState() {
    var state = loadState();
    return {
      schema_version: state.schema_version,
      lastSessionDate: state.lastSessionDate,
      streakDays: state.streakDays || 0,
      totalSessionsCount: state.totalSessionsCount || 0,
      firstUsedAt: state.firstUsedAt,
      sessions: (state.sessions || []).slice()
    };
  }

  // -------------------------------------------------------------
  // 11. 公開 API
  // -------------------------------------------------------------
  global.SteadyUseLog = {
    __version: 'v3.2.0r2-block8-h2-p13',
    startSession: startSession,
    endSession: endSession,
    recordPatternUse: recordPatternUse,
    getStreakDays: getStreakDays,
    getDailyUseCount: getDailyUseCount,
    getSummary: getSummary,
    getState: getState,
    // 内部公開（テスト/監査用）
    _internal: {
      LS_KEY: LS_KEY,
      SCHEMA_VERSION: SCHEMA_VERSION,
      MAX_SESSIONS: MAX_SESSIONS,
      todayYMD: todayYMD,
      yesterdayYMD: yesterdayYMD,
      loadState: loadState,
      saveState: saveState,
      upsertSession: upsertSession
    }
  };

  // -------------------------------------------------------------
  // 12. 自動 startSession / endSession 配線
  // -------------------------------------------------------------
  if (typeof document !== 'undefined' && document.readyState !== 'loading') {
    try { startSession(); } catch (_) {}
  } else if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function () {
      try { startSession(); } catch (_) {}
    }, { once: true });
  }

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('beforeunload', function () {
      try { endSession(); } catch (_) {}
    });
    // iOS Safari の bfcache 対策
    global.addEventListener('pagehide', function () {
      try { endSession(); } catch (_) {}
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
