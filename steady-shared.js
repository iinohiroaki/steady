/* =============================================================
   STEADY v3.2.0r2 共通スクリプト（steady-shared.js）
   - 3 HTML（steady-core / steady-game / steady-ear）共通の土台
   - 役割：
     1. 旧 Blob URL ベース SW のクリーンアップ → 新 steady-sw.js 登録（AL011 F1 採用）
     2. migrateToV3_2 migration block（M2 採用・冪等）
     3. localStorage ラッパ（lsGet/lsSet・3 HTML 共通キーの単一定義）
     4. テーマ適用・3 HTML 間ナビゲーションのアクティブ表示
     5. A2HS 検出・persist() 申請のフック（B1 で本実装）
   - 既存 steady.html v3.0.1 PASS のロジックを破壊しない（並走運用）
   ============================================================= */

(function (global) {
  'use strict';

  // -------------------------------------------------------------
  // DEBUG_FLAG（v3.2.0r2 hotfix）
  //   - production では false（console silent）
  //   - debug 時は手動で true に切替えると migration / SW / qskill 等のログが出る
  //   - 各 console.* 呼び出しは `if (global.STEADY_DEBUG) console.*(...)` で囲む
  // -------------------------------------------------------------
  if (typeof global.STEADY_DEBUG === 'undefined') global.STEADY_DEBUG = false;

  // -------------------------------------------------------------
  // 0. localStorage キー定義（3 HTML 共通・新規キーは _v3_2 サフィックス・AL011 M1）
  // -------------------------------------------------------------
  // 既存 LS_* キー（破壊厳禁・migration で保護）
  var LEGACY_KEYS = [
    'steady_band_next', 'steady_impl_intent', 'steady_streak_freeze',
    'steady_recommend_cache', 'steady_logs', 'steady_streak_best',
    'steady_theme', 'steady_mic_offset', 'steady_tutorial_done',
    'steady_tutorial_modes', 'steady_swclean_v3', 'steady_click_sound',
    'steady_notify_enabled', 'steady_notify_morning', 'steady_notify_evening'
  ];
  // v3.2.0r2 新規キー（v3_2 サフィックス統一）
  var LS_V32 = {
    PHASE1_PROGRESS: 'steady_phase1_progress_v3_2',
    COACHING_BAG: 'steady_coaching_bag_v3_2',
    PWA_ONBOARD: 'steady_pwa_onboard_v3_2',
    PERSIST_GRANTED: 'steady_persist_granted_v3_2',
    LAST_EXPORT: 'steady_last_export_v3_2',
    QSKILL_RESULT: 'steady_qskill_v2_result',
    QSKILL_RESULT_V32: 'steady_qskill_v2_result_v3_2', // B2: 結果（軸スコア＋Stage＋推奨）
    QSKILL_PROGRESS_V32: 'steady_qskill_v2_progress_v3_2', // B2: 中断保存（出題順・回答済 index）
    MIGRATION_DONE: 'steady_migration_v3_2_done', // 冪等性フラグ
    SW_PHYSICAL_READY: 'steady_sw_physical_ready_v3_2', // 旧Blob → 物理SW切替完了
    LAST_VISIT_HTML: 'steady_last_visit_html_v3_2', // 最後に開いた HTML（ナビ用）
    FIRST_SEEN: 'steady_first_seen_v3_2', // 初回起動時刻（7日 fallback の基点）
    EXPORT_LATER_AT: 'steady_export_later_at_v3_2', // 「あとで」タップ時刻（24h 抑制）
    // ----- B7：8 patterns LS キー一覧（A-6 統一・exportAllToJSON 対象）-----
    P1_BPM:                 'steady_p1_six_stroke_bpm_v3_2',
    P1_LAST_PLAYED:         'steady_p1_six_stroke_lastPlayed_v3_2',
    P1_STEPS:               'steady_p1_six_stroke_steps_v3_2',
    P2_BPM:                 'steady_p2_sizzle_hat_bpm_v3_2',
    P2_LAST_PLAYED:         'steady_p2_sizzle_hat_lastPlayed_v3_2',
    P2_OPENNESS:            'steady_p2_sizzle_hat_openness_v3_2',
    P2_CURRENT_BAR:         'steady_p2_sizzle_hat_currentBar_v3_2',
    P3_BPM:                 'steady_p3_halftime_shuffle_bpm_v3_2',
    P3_LAST_PLAYED:         'steady_p3_halftime_shuffle_lastPlayed_v3_2',
    P3_FEEL:                'steady_p3_halftime_shuffle_feel_v3_2',
    P3_STEPS:               'steady_p3_halftime_shuffle_steps_v3_2',
    P4_BPM:                 'steady_p4_4bar_fills_bpm_v3_2',
    P4_LAST_PLAYED:         'steady_p4_4bar_fills_lastPlayed_v3_2',
    P4_CURRENT_FILL:        'steady_p4_4bar_fills_currentFill_v3_2',
    P4_CURRENT_BAR:         'steady_p4_4bar_fills_currentBar_v3_2',
    P4_ROTATION_MODE:       'steady_p4_4bar_fills_rotationMode_v3_2',
    P5_BPM:                 'steady_p5_octopus_bpm_v3_2',
    P5_LAST_PLAYED:         'steady_p5_octopus_lastPlayed_v3_2',
    P5_STEPS:               'steady_p5_octopus_steps_v3_2',
    P5_DK_VIZ_ENABLED:      'steady_p5_octopus_dk_viz_enabled_v3_2',
    P6_BPM:                 'steady_p6_crash_quarter_bpm_v3_2',
    P6_LAST_PLAYED:         'steady_p6_crash_quarter_lastPlayed_v3_2',
    P7_BPM:                 'steady_p7_ride_bell_bpm_v3_2',
    P7_LAST_PLAYED:         'steady_p7_ride_bell_lastPlayed_v3_2',
    P8_BPM:                 'steady_p8_subtractive_bpm_v3_2',
    P8_ROTATION_MODE:       'steady_p8_subtractive_rotation_mode_v3_2',
    P8_SELECTED_VARIATION:  'steady_p8_subtractive_selected_variation_v3_2',
    P8_LAST_PLAYED:         'steady_p8_subtractive_lastPlayed_v3_2',
    P8_PLAYED_VARIATIONS:   'steady_p8_subtractive_played_variations_v3_2',
    // P13 SteadyUseLog 機構（試用フロー §4-1 観察項目の物理化・block8-h2 で追加）
    USE_LOG:                'steady_use_log_v3_2',
    // B8 Run 7（UX-02）：A2HS engagement-trigger バナーの dismiss フラグ
    A2HS_DISMISSED:         'steady_a2hs_dismissed_v3_2',
    // B8 Run 7（UX-02）：A2HS バナー表示済フラグ（hasPromptedA2HS 相当）
    A2HS_PROMPTED:          'steady_a2hs_prompted_v3_2',
    // B8 Run 7（UX-11）：14 日連続未使用警告の dismiss フラグ
    STALE_WARN_DISMISSED:   'steady_stale_warn_dismissed_v3_2',
    // Phase D（v3.2.0r2 block8-h5）：オートバトル GAME_STATE namespace
    //   schema_version: 1 / xp / coins / level / equipment[] / titles[] / records / prestige / defeated{} / settings
    GAME_STATE:             'steady_game_state_v3_2'
  };

  // -------------------------------------------------------------
  // 1. localStorage ラッパ（既存 steady.html と互換）
  // -------------------------------------------------------------
  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }
  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }
  function lsRemove(key) {
    try { localStorage.removeItem(key); return true; } catch (_) { return false; }
  }

  // -------------------------------------------------------------
  // 2. migrateToV3_2 migration block（M2 採用・冪等）
  //    - 既存 LS_* キーは保護（読まない・書かない・触らない）
  //    - 新規 v3_2 キーの初期化のみ実施
  //    - 旧 Blob URL ベース SW のクリーンアップ（既存 steady_swclean_v3 を再利用）
  //    - 複数回実行で副作用ゼロ（migration_done フラグで早期 return）
  // -------------------------------------------------------------
  function migrateToV3_2() {
    var done = lsGet(LS_V32.MIGRATION_DONE, false);
    if (done === true) {
      return { migrated: false, reason: 'already-done' };
    }

    var report = { migrated: true, initialized: [], protected_legacy: [], errors: [] };

    // 2-1. レガシーキー保護確認（読み取って上書きしない）
    LEGACY_KEYS.forEach(function (k) {
      try {
        if (localStorage.getItem(k) !== null) {
          report.protected_legacy.push(k);
        }
      } catch (e) { report.errors.push('read-' + k + ':' + e.message); }
    });

    // 2-2. 新規 v3_2 キーの初期化（既に存在する場合はスキップ）
    var defaults = {};
    defaults[LS_V32.PHASE1_PROGRESS] = {
      sixstroke: 0, sizzle_hat: 0, halftime: 0, fourbar_fills: 0,
      octopus: 0, crash4: 0, ride_bell: 0, subtractive: 0
    };
    defaults[LS_V32.COACHING_BAG] = { bag: [], category: 'mixed', refilled_at: null };
    defaults[LS_V32.PWA_ONBOARD] = false;
    defaults[LS_V32.PERSIST_GRANTED] = null; // null=未申請, true=granted, false=denied
    defaults[LS_V32.LAST_EXPORT] = null;
    defaults[LS_V32.QSKILL_RESULT] = null;
    defaults[LS_V32.QSKILL_RESULT_V32] = null; // B2: { axes:{time,technique,...}, minScore, stage, decidedAt, recommended }
    defaults[LS_V32.QSKILL_PROGRESS_V32] = null; // B2: { questionOrder:[...], answers:{q_id:'a'|'b'}, currentIndex, startedAt }
    defaults[LS_V32.LAST_VISIT_HTML] = null;
    defaults[LS_V32.FIRST_SEEN] = Date.now(); // migration 時に初期化（一度だけ）
    defaults[LS_V32.EXPORT_LATER_AT] = null;
    // P13 SteadyUseLog 機構（block8-h2 で追加）：schema 初期化のみ・実際の startSession は steady-use-log.js が自動配線
    defaults[LS_V32.USE_LOG] = {
      schema_version: 1,
      firstUsedAt: null,
      lastSessionDate: null,
      streakDays: 0,
      totalSessionsCount: 0,
      sessions: []
    };
    // B8 Run 7（UX-02 / UX-11）初期化
    defaults[LS_V32.A2HS_DISMISSED] = false;
    defaults[LS_V32.A2HS_PROMPTED] = false;
    defaults[LS_V32.STALE_WARN_DISMISSED] = null; // 直近 dismiss 時刻（24h で再表示）
    // Phase D：GAME_STATE 初期スキーマ（schema_version: 1）
    defaults[LS_V32.GAME_STATE] = {
      schema_version: 1,
      xp: 0,
      coins: 0,
      level: 1,
      prestige: 0,
      equipment: [],   // [{id, name, slot, rarity, atk, hp, acc, dropAt}]
      titles: [],      // [{id, name, unlockedAt}]
      defeated: {},    // { enemy_id: {count, firstAt, bestTimeMs, bestDmg} }
      records: {       // 歴代
        bestDamage: 0,
        fastestWinMs: null,
        longestStreak: 0,
        currentStreak: 0
      },
      lastChargeAt: null,
      battlesPlayed: 0,
      wins: 0,
      losses: 0
    };

    Object.keys(defaults).forEach(function (key) {
      try {
        if (localStorage.getItem(key) === null) {
          lsSet(key, defaults[key]);
          report.initialized.push(key);
        }
      } catch (e) {
        report.errors.push('init-' + key + ':' + e.message);
      }
    });

    // 2-3. 旧 Blob URL ベース SW の強制クリーンアップ（v3.0.1 の Blob SW を全消去）
    //      既存 steady_swclean_v3 は v3.0.1 用のフラグ → v3.2.0r2 では別フラグで再実行
    forceServiceWorkerCleanupOnce_v3_2();

    // 2-4. migration done フラグ
    lsSet(LS_V32.MIGRATION_DONE, true);
    return report;
  }

  // -------------------------------------------------------------
  // 2.5. GAME_STATE schema_version 1 → 2 migration（v3.3.0 phase 0 / SS-8）
  //     - 既存 GAME_STATE を読み、schema_version をチェック
  //     - schema_version === undefined or 1 → 2 に bump
  //     - v3.3.0 で導入された field（stars / weeklyHistory / weeklyDefeats /
  //       loseStreak / lateNightDefeats / streakDays）の不足を default 補完
  //     - 既存 fields（xp / coins / level / equipment[] / titles[] / records /
  //       prestige / defeated{} / settings / lastChargeAt / battlesPlayed /
  //       wins / losses）は一字一句保持
  //     - state が null / 非 object の場合は migration スキップ（壊さない）
  //     - 引数 state を破壊的に変更し、同 reference を返す（呼び出し側で saveState 推奨）
  //     - migration 失敗時は警告ログを STEADY_DEBUG ガード経由で出力・state は触らない
  // -------------------------------------------------------------
  function migrateGameState(state) {
    try {
      // 入力 guard：null / 非 object はそのまま返す（loadState 側の新規初期化に委ねる）
      if (!state || typeof state !== 'object') return state;

      var sv = state.schema_version;
      // 既に schema_version >= 2 ならスキップ（冪等）
      if (typeof sv === 'number' && sv >= 2) return state;

      // schema_version 1 → 2 bump（undefined は 1 相当として扱う）
      // 既存 fields は一切触らず、不足 fields のみ default 補完
      if (typeof state.stars !== 'number') state.stars = 0;
      if (!Array.isArray(state.weeklyHistory)) state.weeklyHistory = [];
      // weeklyHistory rolling 上限 200 件は steady-game.js 側で維持。migration 時に既存超過は切り詰めない（既存を尊重）
      if (!state.weeklyDefeats || typeof state.weeklyDefeats !== 'object' || Array.isArray(state.weeklyDefeats)) {
        state.weeklyDefeats = {};
      }
      if (typeof state.loseStreak !== 'number') state.loseStreak = 0;
      if (typeof state.lateNightDefeats !== 'number') state.lateNightDefeats = 0;
      if (typeof state.streakDays !== 'number') state.streakDays = 0;

      // schema_version を 2 に bump
      state.schema_version = 2;
      return state;
    } catch (e) {
      try {
        if (global.STEADY_DEBUG) console.warn('[steady] migrateGameState error:', e);
      } catch (_) {}
      // 失敗時は state を壊さず返す
      return state;
    }
  }

  // -------------------------------------------------------------
  // 2.6. GAME_STATE migration 起動時実行（永続化込み）
  //     - bootShared から呼ばれる
  //     - 既存 GAME_STATE が無い場合は何もしない（migrateToV3_2 が初期化済 or
  //       steady-game.js の loadState が新規生成）
  //     - schema_version が変わった場合のみ書き戻す（無駄な write 抑制）
  // -------------------------------------------------------------
  function migrateGameStateOnBoot() {
    try {
      var key = LS_V32.GAME_STATE;
      var raw = lsGet(key, null);
      if (!raw || typeof raw !== 'object') return { migrated: false, reason: 'no-state' };
      var beforeSv = raw.schema_version;
      var migrated = migrateGameState(raw);
      if (migrated && migrated.schema_version !== beforeSv) {
        lsSet(key, migrated);
        return { migrated: true, from: beforeSv || 1, to: migrated.schema_version };
      }
      return { migrated: false, reason: 'already-current', schema_version: beforeSv };
    } catch (e) {
      try {
        if (global.STEADY_DEBUG) console.warn('[steady] migrateGameStateOnBoot error:', e);
      } catch (_) {}
      return { migrated: false, reason: 'error', error: e && e.message };
    }
  }

  // -------------------------------------------------------------
  // 3. 旧 SW（Blob URL ベース）の一発クリーンアップ
  //    - 既存 steady.html L13-44 のロジックを v3.2.0r2 用に延長
  //    - clean フラグは別キー（steady_sw_physical_ready_v3_2）
  //    - 物理 SW（steady-sw.js）への登録切替を保証
  // -------------------------------------------------------------
  function forceServiceWorkerCleanupOnce_v3_2() {
    try {
      // 4-5. 二重ガード：v3_2 用クリーンアップが完了済なら早期 return（冪等性保証）
      // 既存 steady_swclean_v3 は v3.0.1 用フラグ。v3.2.0r2 では別フラグ（SW_PHYSICAL_READY）で再実行可。
      if (lsGet(LS_V32.SW_PHYSICAL_READY, false) === true) return;
      // 4-6. SW 判定：navigator.serviceWorker 不在環境（古い Safari / iframe）はクリーンアップ不要
      // フラグだけ立てて以降スキップ（次回起動でも再評価しない）
      if (!('serviceWorker' in navigator)) {
        lsSet(LS_V32.SW_PHYSICAL_READY, true);
        return;
      }
      // 旧 Blob SW を全 unregister（物理 SW はあとで register する）
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) {
          // 4-7. Blob判定：scriptURL が blob: で始まる SW のみ unregister 対象
          // 物理ファイル経由（http(s):// で始まる）は既に新 SW なので残置。
          // active が null なケース（installing/waiting 中）は判定不可なので skip（次回起動で再評価）
          var isBlob = r.active && r.active.scriptURL && r.active.scriptURL.indexOf('blob:') === 0;
          if (isBlob) {
            return r.unregister().catch(function () {});
          }
          return Promise.resolve();
        }));
      }).then(function () {
        // Cache API 旧バージョンも除去
        if (global.caches && global.caches.keys) {
          return global.caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (k) {
              if (k.indexOf('steady-v3.0') === 0 || k.indexOf('steady-v3.1') === 0) {
                return global.caches.delete(k).catch(function () {});
              }
              return Promise.resolve();
            }));
          });
        }
      }).then(function () {
        lsSet(LS_V32.SW_PHYSICAL_READY, true);
      }).catch(function () {
        // エラーでも next register は試みる
        lsSet(LS_V32.SW_PHYSICAL_READY, true);
      });
    } catch (_) { /* noop */ }
  }

  // -------------------------------------------------------------
  // 4. 物理 SW 登録（steady-sw.js）
  //    - 3 HTML すべてからこの関数を呼ぶ → 同一 scope 共有
  //    - 既存 steady.html のインライン Blob 登録は本ファイル経由では呼ばれない
  // -------------------------------------------------------------
  function registerPhysicalSW() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    try {
      // scope は同一ディレクトリで OK（manifest と揃える）
      return navigator.serviceWorker.register('./steady-sw.js', { scope: './' })
        .then(function (reg) {
          return reg;
        })
        .catch(function (err) {
          if (global.STEADY_DEBUG) console.warn('[steady] SW register failed:', err);
          return null;
        });
    } catch (e) {
      if (global.STEADY_DEBUG) console.warn('[steady] SW register threw:', e);
      return Promise.resolve(null);
    }
  }

  // -------------------------------------------------------------
  // 5. PWA インストール（A2HS）検出
  //    - display-mode: standalone で判定
  //    - persist() 申請のトリガに使う（B1 で本実装）
  // -------------------------------------------------------------
  function isStandalone() {
    try {
      if (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) return true;
      // iOS Safari の独自プロパティ
      if (global.navigator && global.navigator.standalone === true) return true;
    } catch (_) {}
    return false;
  }

  function requestPersistIfNeeded() {
    // A2HS 取得後にのみ呼ぶ（granted 確度を上げる・matrix #8 r2）
    if (!isStandalone()) {
      return Promise.resolve({ persisted: null, reason: 'not-standalone' });
    }
    if (!global.navigator || !global.navigator.storage || !global.navigator.storage.persist) {
      return Promise.resolve({ persisted: null, reason: 'api-unavailable' });
    }
    var cached = lsGet(LS_V32.PERSIST_GRANTED, null);
    if (cached === true) return Promise.resolve({ persisted: true, reason: 'cached' });
    return global.navigator.storage.persist().then(function (granted) {
      lsSet(LS_V32.PERSIST_GRANTED, !!granted);
      return { persisted: !!granted, reason: granted ? 'granted' : 'denied' };
    }).catch(function (err) {
      return { persisted: null, reason: 'error:' + (err && err.message || err) };
    });
  }

  // -------------------------------------------------------------
  // 6. テーマ適用（共通）
  // -------------------------------------------------------------
  function applyTheme() {
    try {
      var t = lsGet('steady_theme', 'light'); // 既存キー保護（_v3_2 サフィックス付けない）
      document.body.classList.toggle('dark', t === 'dark');
    } catch (_) {}
  }

  function toggleTheme() {
    try {
      var cur = lsGet('steady_theme', 'light');
      var next = cur === 'dark' ? 'light' : 'dark';
      lsSet('steady_theme', next);
      applyTheme();
    } catch (_) {}
  }

  // -------------------------------------------------------------
  // 7. 3 HTML 間ナビゲーション（フローティングナビのアクティブ表示）
  // -------------------------------------------------------------
  function markActiveNav() {
    try {
      var path = (location.pathname || '').toLowerCase();
      var here = 'core';
      if (path.indexOf('steady-game') !== -1) here = 'game';
      else if (path.indexOf('steady-ear') !== -1) here = 'ear';
      else here = 'core';
      lsSet(LS_V32.LAST_VISIT_HTML, here);

      var nav = document.querySelector('.float-nav');
      if (!nav) return;
      nav.querySelectorAll('a').forEach(function (a) {
        a.classList.toggle('active', a.dataset.html === here);
      });
    } catch (_) {}
  }

  // -------------------------------------------------------------
  // 8. データ保全状況の estimate（設定画面表示用・B1 で UI 接続）
  // -------------------------------------------------------------
  function getStorageEstimate() {
    if (!global.navigator || !global.navigator.storage || !global.navigator.storage.estimate) {
      return Promise.resolve(null);
    }
    return global.navigator.storage.estimate().then(function (e) {
      return { usage: e.usage || 0, quota: e.quota || 0 };
    }).catch(function () { return null; });
  }

  // -------------------------------------------------------------
  // 9. JSON エクスポート（B1 で本格 fallback 化・骨格のみ）
  //    - 全 LS_* キー＋ v3_2 キー＋ IndexedDB 録音 Blob を1ファイルに
  //    - ここでは LS のみ収集（IndexedDB は B10 で実装）
  // -------------------------------------------------------------
  function exportAllToJSON() {
    var data = {
      exported_at: new Date().toISOString(),
      version: 'v3.2.0r2',
      legacy: {},
      v3_2: {},
      indexeddb_recordings: [] // B10 で実装
    };
    try {
      LEGACY_KEYS.forEach(function (k) {
        var v = localStorage.getItem(k);
        if (v !== null) data.legacy[k] = v;
      });
      Object.keys(LS_V32).forEach(function (sym) {
        var key = LS_V32[sym];
        var v = localStorage.getItem(key);
        if (v !== null) data.v3_2[key] = v;
      });
    } catch (_) {}
    return data;
  }

  function downloadJSONExport() {
    try {
      var data = exportAllToJSON();
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      var d = new Date();
      var ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      a.download = 'steady_backup_' + ymd + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      lsSet(LS_V32.LAST_EXPORT, Date.now());
      return true;
    } catch (e) {
      if (global.STEADY_DEBUG) console.warn('export failed:', e);
      return false;
    }
  }

  // -------------------------------------------------------------
  // 10. 起動シーケンス（DOMContentLoaded 後に呼ぶ）
  // -------------------------------------------------------------
  function bootShared() {
    try {
      migrateToV3_2();
    } catch (e) {
      if (global.STEADY_DEBUG) console.warn('[steady] migration error:', e);
    }
    // v3.3.0 phase 0 / SS-8：GAME_STATE schema_version 1 → 2 migration
    // migrateToV3_2 の後に走らせる（GAME_STATE の初期化が済んでいる前提）
    try {
      migrateGameStateOnBoot();
    } catch (e) {
      if (global.STEADY_DEBUG) console.warn('[steady] gamestate migration error:', e);
    }
    try { ensureFirstSeen(); } catch (_) {}
    try { applyTheme(); } catch (_) {}
    try { markActiveNav(); } catch (_) {}
    // B8 Run 5 G2（UX-10 spring 演出）：steady-core.html の phase1ProgressFill 等
    // 既存 progress-fill 要素に spring-bar class を後付け（HTML body 部の構造変更を避けるため
    // JS 側から付与）。data-no-spring 属性が付いている要素は除外して既存挙動を保つ
    try {
      var fills = document.querySelectorAll('.progress-fill:not([data-no-spring])');
      fills.forEach(function (el) {
        if (!el.classList.contains('spring-bar')) el.classList.add('spring-bar');
      });
    } catch (_) {}
    // SW 登録は migration の Blob クリーンアップ完了後に走らせる（少し待つ）
    setTimeout(function () {
      registerPhysicalSW();
    }, 400);
    // A2HS 取得済なら persist() を試みる（B1 で本格 UI）
    setTimeout(function () {
      if (isStandalone()) {
        requestPersistIfNeeded();
      }
    }, 1200);
    // B8 Run 7：UX-02 / UX-09 / UX-11 の deferred 起動
    try { bootRun7(); } catch (e) { if (global.STEADY_DEBUG) console.warn('[steady] run7 boot error:', e); }
  }

  // -------------------------------------------------------------
  // 11. iOS Safari 検出（A2HS UI 出し分け用）
  //     - User-Agent と navigator.platform の併用（iPad iOS 13+ desktop UA 対策）
  //     - 検出のみ・機能制限はかけない（全 OS で A2HS 案内は出す。文言だけ iOS 系に最適化）
  // -------------------------------------------------------------
  function isIOSSafari() {
    try {
      var ua = (global.navigator && global.navigator.userAgent) || '';
      var plat = (global.navigator && global.navigator.platform) || '';
      var maxTouch = (global.navigator && global.navigator.maxTouchPoints) || 0;
      // iPhone/iPod/iPad 旧UA
      var isIOSUA = /iPhone|iPad|iPod/.test(ua);
      // iPadOS 13+ は Mac UA を返すので touchPoints で見分ける
      var isIPadOS = plat === 'MacIntel' && maxTouch > 1;
      var isIOS = isIOSUA || isIPadOS;
      if (!isIOS) return false;
      // Safari 系（CriOS/FxiOS/EdgiOS は弾く＝非 Safari は本来の A2HS exemption 経路と異なる）
      var isNonSafari = /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
      return !isNonSafari;
    } catch (_) { return false; }
  }

  // -------------------------------------------------------------
  // 12. EU 域内ヒューリスティック検出（A2HS exemption 失効リスク表示用）
  //     - timezone と Accept-Language（navigator.language(s)）で雑検出
  //     - 確実な geo 判定ではなく「警告を出す/出さない」レベルの精度
  // -------------------------------------------------------------
  function isLikelyEU() {
    try {
      // 1. タイムゾーンによる判定
      var tz = '';
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      } catch (_) {}
      // EU圏代表的な timezone
      var euTZPrefixes = [
        'Europe/' // Europe/Berlin, Europe/Paris, Europe/Madrid 等
      ];
      // ただし Europe/London(英・EU離脱)、Europe/Moscow(ロシア・非EU) 等は誤検出含むが許容
      var byTZ = euTZPrefixes.some(function (p) { return tz.indexOf(p) === 0; });
      if (byTZ) return true;
      // 2. 言語による補助判定は弱いため不採用（タイムゾーンがヨーロッパ以外なら EU 判定しない）
      // ここに到達した時点で TZ は Europe/ ではない → EU でない
      return false;
    } catch (_) { return false; }
  }

  // -------------------------------------------------------------
  // 13. 7日消去 fallback ポップアップ判定
  //     - 戻り値: { show:bool, reason:string, daysSince:number|null }
  //     - show=true 条件:
  //       (A) standalone でない かつ persist 未取得 かつ
  //       (B) lastExport が 6.5日以上前 or 一度もエクスポートしてない場合は初回起動から 6.5日経過
  //     - 「最終起動」相当として lastVisit_v3_2 を migration 直後に書く（B1 で追加）
  // -------------------------------------------------------------
  function shouldShowExportWarn() {
    try {
      var standalone = isStandalone();
      var persisted = lsGet(LS_V32.PERSIST_GRANTED, null);
      // standalone & persisted=granted は最も安全 → 警告不要
      if (standalone && persisted === true) {
        return { show: false, reason: 'standalone-persisted', daysSince: null };
      }
      var now = Date.now();
      var lastExp = lsGet(LS_V32.LAST_EXPORT, null);
      var firstSeen = lsGet(LS_V32.FIRST_SEEN, null);
      var threshold = (7 - 0.5) * 24 * 60 * 60 * 1000; // 6.5日
      // 一度も export していない場合は first_seen からの経過で判定
      var anchor = (typeof lastExp === 'number') ? lastExp : firstSeen;
      if (typeof anchor !== 'number') {
        return { show: false, reason: 'no-anchor', daysSince: null };
      }
      var elapsed = now - anchor;
      var daysSince = Math.floor(elapsed / (24 * 60 * 60 * 1000) * 10) / 10;
      // 「あとで」を直近24時間以内に押されていたら抑制
      var laterAt = lsGet(LS_V32.EXPORT_LATER_AT, null);
      if (typeof laterAt === 'number' && (now - laterAt) < (24 * 60 * 60 * 1000)) {
        return { show: false, reason: 'snoozed', daysSince: daysSince };
      }
      if (elapsed >= threshold) {
        return { show: true, reason: lastExp ? 'export-stale' : 'never-exported', daysSince: daysSince };
      }
      return { show: false, reason: 'within-window', daysSince: daysSince };
    } catch (_) {
      return { show: false, reason: 'error', daysSince: null };
    }
  }

  // -------------------------------------------------------------
  // 14. データサマリ（バックアップ画面で使用 — 件数のみ・中身は出さない）
  // -------------------------------------------------------------
  function summarizeStoredData() {
    var summary = {
      legacyKeysFound: 0,
      v32KeysFound: 0,
      totalBytesApprox: 0,
      lastExportAt: null,
      persistGranted: null,
      standalone: false
    };
    try {
      LEGACY_KEYS.forEach(function (k) {
        var v = localStorage.getItem(k);
        if (v !== null) {
          summary.legacyKeysFound += 1;
          summary.totalBytesApprox += (k.length + v.length) * 2; // UTF-16 概算
        }
      });
      Object.keys(LS_V32).forEach(function (sym) {
        var key = LS_V32[sym];
        var v = localStorage.getItem(key);
        if (v !== null) {
          summary.v32KeysFound += 1;
          summary.totalBytesApprox += (key.length + v.length) * 2;
        }
      });
      summary.lastExportAt = lsGet(LS_V32.LAST_EXPORT, null);
      summary.persistGranted = lsGet(LS_V32.PERSIST_GRANTED, null);
      summary.standalone = isStandalone();
    } catch (_) {}
    return summary;
  }

  // -------------------------------------------------------------
  // 15. A2HS 「設定完了」適用（AL012 NEW-4 対処）
  //     - ユーザーが「追加した」をタップした時のステータス文言生成
  //     - factual 寄り（旧「ありがとう」を撤去）
  // -------------------------------------------------------------
  function getA2HSDoneStatus() {
    // standalone 確認できれば「ホーム画面起動を確認」
    // 確認できなければ「設定を保存。次回ホーム画面アイコンから開いてください」
    if (isStandalone()) {
      return 'ホーム画面アイコンからの起動を確認しました。';
    }
    return '設定を保存しました。次回はホーム画面のアイコンから開いてください。';
  }

  // -------------------------------------------------------------
  // 16. first_seen 記録（migration から呼ぶ・冪等）
  // -------------------------------------------------------------
  function ensureFirstSeen() {
    try {
      var fs = lsGet(LS_V32.FIRST_SEEN, null);
      if (fs === null) {
        lsSet(LS_V32.FIRST_SEEN, Date.now());
      }
    } catch (_) {}
  }

  // -------------------------------------------------------------
  // 16b. 共通 attachBackupUI（B2 共通化リファクタ・refreshSummary 散布解消）
  //   - core/game/ear の 3 HTML で繰り返されていた refreshSummary 処理を単一化
  //   - 必須要素 ID（任意）：sumCount / sumBytes / sumLastExport / sumStandalone
  //   - 各 HTML 側は以下の DOM があれば自動的に同じ表示が得られる：
  //       <div class="backup-summary">
  //         <div><dt>...</dt><dd id="sumCount"></dd></div>
  //         <div><dt>...</dt><dd id="sumBytes"></dd></div>
  //         <div><dt>...</dt><dd id="sumLastExport"></dd></div>
  //         <div><dt>...</dt><dd id="sumStandalone"></dd></div>  <!-- 任意（core 側のみ） -->
  //       </div>
  //   - opts.detailedCount=true で「N 件（既存 X / 新規 Y）」表記に切替（core 互換）
  // -------------------------------------------------------------
  function attachBackupUI(opts) {
    opts = opts || {};
    var byId = function (id) { var el = document.getElementById(id); return el; };
    var refresh = function () {
      try {
        var sum = summarizeStoredData();
        var cEl = byId('sumCount');
        if (cEl) {
          if (opts.detailedCount) {
            cEl.textContent = (sum.legacyKeysFound + sum.v32KeysFound) + ' 件（既存 ' + sum.legacyKeysFound + ' / 新規 ' + sum.v32KeysFound + '）';
          } else {
            cEl.textContent = (sum.legacyKeysFound + sum.v32KeysFound) + ' 件';
          }
        }
        var bEl = byId('sumBytes');
        if (bEl) bEl.textContent = (sum.totalBytesApprox / 1024).toFixed(1) + ' KB';
        var lEl = byId('sumLastExport');
        if (lEl) {
          if (typeof sum.lastExportAt === 'number') {
            var d = new Date(sum.lastExportAt);
            lEl.textContent = d.toLocaleString('ja-JP');
          } else {
            lEl.textContent = 'まだ書き出していません';
          }
        }
        var sEl = byId('sumStandalone');
        if (sEl) sEl.textContent = sum.standalone ? '有効' : 'ブラウザタブ表示';
      } catch (_) {}
    };
    refresh();
    return refresh;
  }

  // -------------------------------------------------------------
  // === Q-SKILL v2 BLOCK 開始（B2 実装・5軸×10問・最低スコア基準） ===
  // -------------------------------------------------------------
  // 設計概要：
  //   - 質問プール `steady-qskill-v2-pool.json` を fetch + メモリキャッシュ
  //   - 5軸（time/technique/sound_production/listening/musicality）から各 stage_target=1 寄りの
  //     2問ずつ抽出 → 10問出題（spec.runtime_extraction）
  //   - 全問 type='ab_comparison' / 回答は 'a' or 'b' のみ（ABSOLUTE RULE 11 準拠）
  //   - スコアリング：軸ごと正解率 → 最低スコア軸を全体 Stage に採用（Yamaha minimum_axis）
  //   - stage_thresholds: [0.4, 0.6, 0.8, 0.95]（spec.scoring）
  //   - 中断保存：currentIndex / answers を localStorage（QSKILL_PROGRESS_V32）に都度保存
  //   - 再開：開始時に PROGRESS が残っていれば「途中から再開」UI 表示
  //   - 音源 fallback：mp3 が 404 の時は MIDI 即時生成（Tone.js 利用・Web Audio）
  //                    Tone.js 不在環境では「音源準備中」テキスト表示で続行可能
  // -------------------------------------------------------------

  var QSKILL_POOL_URL = './steady-qskill-v2-pool.json';
  var qskillPoolCache = null; // メモリキャッシュ（同一セッション内）
  var qskillPoolPromise = null;

  function loadQSkillPool() {
    if (qskillPoolCache) return Promise.resolve(qskillPoolCache);
    if (qskillPoolPromise) return qskillPoolPromise;
    qskillPoolPromise = fetch(QSKILL_POOL_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('pool fetch failed: ' + res.status);
        return res.json();
      })
      .then(function (json) {
        qskillPoolCache = json;
        return json;
      })
      .catch(function (err) {
        qskillPoolPromise = null; // 失敗したら次回再試行可
        throw err;
      });
    return qskillPoolPromise;
  }

  // 出題セット生成：5軸×2問＝10問（stage_target=1 を優先・既存進捗があれば優先解除）
  function buildQSkillQuestionSet(pool) {
    var axes = ['time', 'technique', 'sound_production', 'listening', 'musicality'];
    var set = [];
    axes.forEach(function (axis) {
      var arr = (pool && pool.axes && pool.axes[axis]) || [];
      // 全 10 問の中から difficulty 'easy' を優先・なければ medium・hard・expert の順
      var byDiff = { easy: [], medium: [], hard: [], expert: [] };
      arr.forEach(function (q) {
        var d = q.difficulty || 'medium';
        if (!byDiff[d]) byDiff[d] = [];
        byDiff[d].push(q);
      });
      var picks = [];
      ['easy', 'medium', 'hard', 'expert'].forEach(function (d) {
        if (picks.length >= 2) return;
        var pool_d = byDiff[d];
        // ランダムに最大 2 件補充（再現性は中断保存で担保）
        var shuffled = pool_d.slice();
        for (var i = shuffled.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
        }
        for (var k = 0; k < shuffled.length && picks.length < 2; k++) {
          picks.push(shuffled[k]);
        }
      });
      picks.forEach(function (q) {
        set.push({ axis: axis, q: q });
      });
    });
    return set; // [{axis, q}, ...] length=10
  }

  // 採点：軸ごと正解率 → 最低スコア軸の Stage を全体 Stage に
  function scoreQSkill(progress, pool) {
    var axes = ['time', 'technique', 'sound_production', 'listening', 'musicality'];
    var axisStats = {};
    axes.forEach(function (a) { axisStats[a] = { correct: 0, total: 0 }; });
    (progress.questionOrder || []).forEach(function (item) {
      var ans = progress.answers && progress.answers[item.q.id];
      var correct = item.q.correct;
      axisStats[item.axis].total += 1;
      if (ans && ans === correct) axisStats[item.axis].correct += 1;
    });
    var axisScores = {};
    var minScore = 1.0;
    axes.forEach(function (a) {
      var s = axisStats[a];
      var ratio = s.total > 0 ? (s.correct / s.total) : 0;
      axisScores[a] = ratio;
      if (ratio < minScore) minScore = ratio;
    });
    // Stage マッピング（spec.stage_thresholds: [0.4, 0.6, 0.8, 0.95]）
    var thresholds = (pool && pool.scoring && pool.scoring.stage_thresholds) || [0.4, 0.6, 0.8, 0.95];
    var stage = 0;
    if (minScore >= thresholds[3]) stage = 4;
    else if (minScore >= thresholds[2]) stage = 3;
    else if (minScore >= thresholds[1]) stage = 2;
    else if (minScore >= thresholds[0]) stage = 1;
    else stage = 0;
    // 推奨：最低軸の中の伸びしろ軸名を返す（B3 emo lab セグメント連携用）
    var weakest = axes[0];
    axes.forEach(function (a) {
      if (axisScores[a] < axisScores[weakest]) weakest = a;
    });
    return {
      axes: axisScores,
      minScore: minScore,
      stage: stage,
      weakest: weakest,
      decidedAt: Date.now()
    };
  }

  // 進捗の保存／読込／クリア
  function saveQSkillProgress(progress) {
    // 出題プールは保存しない（id 列のみ保存して、再開時にプールから引き直す）
    var minimal = {
      version: 'v3.2.0r2',
      startedAt: progress.startedAt || Date.now(),
      currentIndex: progress.currentIndex || 0,
      answers: progress.answers || {},
      idOrder: (progress.questionOrder || []).map(function (item) {
        return { axis: item.axis, qid: item.q.id };
      })
    };
    return lsSet(LS_V32.QSKILL_PROGRESS_V32, minimal);
  }

  function loadQSkillProgress(pool) {
    var saved = lsGet(LS_V32.QSKILL_PROGRESS_V32, null);
    if (!saved || !saved.idOrder || !Array.isArray(saved.idOrder) || saved.idOrder.length === 0) {
      return null;
    }
    // pool から id を引き直して questionOrder を復元
    var order = [];
    var ok = true;
    saved.idOrder.forEach(function (e) {
      var arr = (pool && pool.axes && pool.axes[e.axis]) || [];
      var q = null;
      for (var i = 0; i < arr.length; i++) { if (arr[i].id === e.qid) { q = arr[i]; break; } }
      if (q) order.push({ axis: e.axis, q: q });
      else ok = false;
    });
    if (!ok || order.length === 0) return null;
    return {
      questionOrder: order,
      currentIndex: saved.currentIndex || 0,
      answers: saved.answers || {},
      startedAt: saved.startedAt || Date.now()
    };
  }

  function clearQSkillProgress() {
    return lsSet(LS_V32.QSKILL_PROGRESS_V32, null);
  }

  function saveQSkillResult(result) {
    return lsSet(LS_V32.QSKILL_RESULT_V32, result);
  }

  function getQSkillResult() {
    return lsGet(LS_V32.QSKILL_RESULT_V32, null);
  }

  // 推奨セグメント文言（B3 連携・直接曲名禁止・評価語禁止）
  function getQSkillRecommendation(result) {
    if (!result) return '診断未実施。';
    var weakAxis = result.weakest || 'time';
    var stage = result.stage || 0;
    var axisLabel = {
      time: 'time（揺らぎ識別）',
      technique: 'technique（手の使い分け）',
      sound_production: 'sound production（音作り）',
      listening: 'listening（聴き取り）',
      musicality: 'musicality（音楽性）'
    }[weakAxis] || weakAxis;
    return 'Stage ' + stage + '。伸びしろ軸：' + axisLabel + '。emo lab で関連 pattern から始めるのが向いています。';
  }
  // -------------------------------------------------------------
  // Q-SKILL v2 UI コントローラ（B2）
  //   - core/game/ear いずれの HTML でもモーダルから起動可能
  //   - 必要 DOM：
  //     <div id="qskillModal" class="modal-backdrop">
  //       <div class="modal-box qskill-box">
  //         <div id="qskillBody"></div>
  //         <div class="row" id="qskillControls"></div>
  //       </div>
  //     </div>
  //   - opts.onComplete(result) でホスト HTML 側に結果通知（emo lab 進捗バー更新等）
  // -------------------------------------------------------------
  function startQSkillModal(opts) {
    opts = opts || {};
    var modal = document.getElementById('qskillModal');
    var body = document.getElementById('qskillBody');
    var ctrls = document.getElementById('qskillControls');
    if (!modal || !body || !ctrls) {
      if (global.STEADY_DEBUG) console.warn('[qskill] modal DOM not found');
      return;
    }
    modal.classList.add('active');

    var session = {
      pool: null,
      questionOrder: null,
      currentIndex: 0,
      answers: {},
      startedAt: Date.now(),
      currentAudio: null
    };

    function escapeHtml(s) {
      return String(s || '').replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function close() {
      modal.classList.remove('active');
      stopAudio();
    }

    function stopAudio() {
      if (session.currentAudio) {
        try { session.currentAudio.pause(); } catch (_) {}
        session.currentAudio = null;
      }
    }

    function renderError(msg) {
      body.innerHTML = '<div class="qskill-error">' + escapeHtml(msg) + '</div>';
      ctrls.innerHTML = '<button class="btn-secondary" id="qskillCloseBtn" type="button">閉じる</button>';
      var c = document.getElementById('qskillCloseBtn');
      if (c) c.addEventListener('click', close);
    }

    function renderIntro(hasResume) {
      var poolInfo = '5 軸 × 2 問（合計 10 問）／ A・B 比較形式';
      body.innerHTML = '' +
        '<h3 class="qskill-title">Q-SKILL v2 — 5 軸診断</h3>' +
        '<p class="qskill-lead">2 つの音源を聴き比べて A か B を選びます。' + poolInfo + '。所要 5〜8 分。</p>' +
        '<ul class="qskill-axes-list">' +
          '<li>time（揺らぎ識別）</li>' +
          '<li>technique（手の使い分け）</li>' +
          '<li>sound production（音作り）</li>' +
          '<li>listening（聴き取り）</li>' +
          '<li>musicality（音楽性）</li>' +
        '</ul>' +
        '<p class="qskill-note muted-text small">採点は最低スコア軸の Stage を全体 Stage として採用します（伸びしろ軸を診断値に）。</p>';
      ctrls.innerHTML = '' +
        (hasResume ? '<button class="btn-primary" id="qskillResume" type="button">途中から再開</button>' : '') +
        '<button class="' + (hasResume ? 'btn-secondary' : 'btn-primary') + '" id="qskillStart" type="button">' + (hasResume ? '最初からやり直す' : '診断を開始') + '</button>' +
        '<button class="btn-secondary" id="qskillCloseBtn" type="button">閉じる</button>';
      var rb = document.getElementById('qskillResume');
      var sb = document.getElementById('qskillStart');
      var cb = document.getElementById('qskillCloseBtn');
      if (rb) rb.addEventListener('click', resumeFromSaved);
      if (sb) sb.addEventListener('click', startFresh);
      if (cb) cb.addEventListener('click', close);
    }

    function startFresh() {
      clearQSkillProgress();
      session.questionOrder = buildQSkillQuestionSet(session.pool);
      session.currentIndex = 0;
      session.answers = {};
      session.startedAt = Date.now();
      saveQSkillProgress(session);
      renderQuestion();
    }

    function resumeFromSaved() {
      var saved = loadQSkillProgress(session.pool);
      if (!saved) { startFresh(); return; }
      session.questionOrder = saved.questionOrder;
      session.currentIndex = saved.currentIndex;
      session.answers = saved.answers;
      session.startedAt = saved.startedAt;
      renderQuestion();
    }

    function playSrc(src, btnId) {
      stopAudio();
      var btn = document.getElementById(btnId);
      // 「準備中」音源（mp3 未生成時）：MIDI 即時生成にフォールバック
      var audio = new Audio();
      audio.preload = 'none';
      audio.src = src;
      session.currentAudio = audio;
      audio.addEventListener('ended', function () {
        if (btn) btn.classList.remove('playing');
      });
      audio.addEventListener('error', function () {
        // 404 等：Tone.js があれば代替音源を即時生成
        if (btn) btn.classList.remove('playing');
        playFallbackSynth(btn);
      });
      audio.play().then(function () {
        if (btn) btn.classList.add('playing');
      }).catch(function () {
        // play 失敗（ユーザジェスチャ要件 / mp3 デコード失敗）→ fallback
        playFallbackSynth(btn);
      });
    }

    function playFallbackSynth(btn) {
      // Tone.js があれば 1 小節分のシンプルなドラムループ → なければテキスト表示
      try {
        if (typeof Tone === 'undefined' || !Tone) {
          var info = document.getElementById('qskillAudioInfo');
          if (info) info.textContent = '音源は準備中です。質問文の手がかりから判断して回答してください。';
          if (btn) btn.classList.remove('playing');
          return;
        }
        if (Tone.context && Tone.context.state !== 'running') {
          try { Tone.start && Tone.start(); } catch (_) {}
        }
        var synth = new Tone.MembraneSynth().toDestination();
        var now = (Tone.now && Tone.now()) || 0;
        // 4 拍ぶんの kick + ghost ノート（揺らぎ識別の参考用）
        for (var i = 0; i < 4; i++) {
          synth.triggerAttackRelease('C2', '8n', now + i * 0.5);
        }
        if (btn) btn.classList.add('playing');
        setTimeout(function () {
          if (btn) btn.classList.remove('playing');
          try { synth.dispose && synth.dispose(); } catch (_) {}
        }, 2200);
      } catch (e) {
        var info2 = document.getElementById('qskillAudioInfo');
        if (info2) info2.textContent = '音源は準備中です。';
        if (btn) btn.classList.remove('playing');
      }
    }

    function renderQuestion() {
      var idx = session.currentIndex;
      var total = session.questionOrder.length;
      if (idx >= total) {
        renderResult();
        return;
      }
      var item = session.questionOrder[idx];
      var q = item.q;
      // 進行バー
      var pct = Math.round((idx / total) * 100);
      body.innerHTML = '' +
        '<div class="qskill-progress-meta">' + (idx + 1) + ' / ' + total + ' 問目 — 軸 ' + escapeHtml(item.axis) + '</div>' +
        // B8 Run 5 G2（UX-10 spring 演出）：progress-fill に spring-bar class を付与
        '<div class="progress-bar"><div class="progress-fill spring-bar" style="width:' + pct + '%;"></div></div>' +
        '<div class="qskill-question">' + escapeHtml(q.question) + '</div>' +
        '<div class="qskill-ab-row">' +
          '<button class="qskill-play-btn" id="qskillPlayA" type="button" aria-label="A を再生">' +
            '<span class="qskill-play-label">A</span>' +
            '<span class="qskill-play-icon" aria-hidden="true">▶</span>' +
          '</button>' +
          '<button class="qskill-play-btn" id="qskillPlayB" type="button" aria-label="B を再生">' +
            '<span class="qskill-play-label">B</span>' +
            '<span class="qskill-play-icon" aria-hidden="true">▶</span>' +
          '</button>' +
        '</div>' +
        '<div class="qskill-audio-info muted-text small" id="qskillAudioInfo"></div>' +
        '<div class="qskill-answer-row">' +
          '<button class="btn-primary qskill-ans" id="qskillAnsA" type="button">A を選ぶ</button>' +
          '<button class="btn-primary qskill-ans" id="qskillAnsB" type="button">B を選ぶ</button>' +
        '</div>';
      ctrls.innerHTML = '' +
        '<button class="btn-secondary" id="qskillSkip" type="button">スキップ（後で再表示）</button>' +
        '<button class="btn-secondary" id="qskillCloseBtn" type="button">中断（途中保存）</button>';

      // イベント
      document.getElementById('qskillPlayA').addEventListener('click', function () {
        playSrc(q.audio_a, 'qskillPlayA');
      });
      document.getElementById('qskillPlayB').addEventListener('click', function () {
        playSrc(q.audio_b, 'qskillPlayB');
      });
      document.getElementById('qskillAnsA').addEventListener('click', function () { answer('a'); });
      document.getElementById('qskillAnsB').addEventListener('click', function () { answer('b'); });
      document.getElementById('qskillSkip').addEventListener('click', function () {
        // スキップは末尾に回す
        var moved = session.questionOrder.splice(idx, 1)[0];
        session.questionOrder.push(moved);
        saveQSkillProgress(session);
        renderQuestion();
      });
      document.getElementById('qskillCloseBtn').addEventListener('click', function () {
        saveQSkillProgress(session);
        close();
      });
    }

    function answer(choice) {
      var item = session.questionOrder[session.currentIndex];
      session.answers[item.q.id] = choice;
      session.currentIndex += 1;
      saveQSkillProgress(session);
      stopAudio();
      renderQuestion();
    }

    function renderResult() {
      var result = scoreQSkill(session, session.pool);
      saveQSkillResult(result);
      clearQSkillProgress(); // 完了後は中断保存をクリア
      var axes = ['time', 'technique', 'sound_production', 'listening', 'musicality'];
      var axisRows = axes.map(function (a) {
        var v = result.axes[a] || 0;
        var pct = Math.round(v * 100);
        return '<div class="qskill-result-axis">' +
          '<div class="qskill-result-axis-name">' + escapeHtml(a) + '</div>' +
          // B8 Run 5 G2（UX-10 spring 演出）
          '<div class="progress-bar"><div class="progress-fill spring-bar" style="width:' + pct + '%;"></div></div>' +
          '<div class="qskill-result-axis-val muted-text small">' + pct + '%</div>' +
          '</div>';
      }).join('');
      body.innerHTML = '' +
        '<h3 class="qskill-title">診断結果</h3>' +
        '<div class="qskill-result-stage">Stage ' + result.stage + '</div>' +
        '<div class="qskill-result-min muted-text small">伸びしろ軸：' + escapeHtml(result.weakest) + '（最低スコアを全体 Stage に採用）</div>' +
        '<div class="qskill-result-axes">' + axisRows + '</div>' +
        '<div class="qskill-result-recommend">' + escapeHtml(getQSkillRecommendation(result)) + '</div>';
      ctrls.innerHTML = '' +
        '<button class="btn-primary" id="qskillFinish" type="button">完了</button>' +
        '<button class="btn-secondary" id="qskillRetake" type="button">再診断</button>';
      document.getElementById('qskillFinish').addEventListener('click', function () {
        close();
        if (typeof opts.onComplete === 'function') opts.onComplete(result);
      });
      document.getElementById('qskillRetake').addEventListener('click', function () {
        startFresh();
      });
    }

    // ローディング状態
    body.innerHTML = '<div class="qskill-loading"><span class="spinner"></span> 質問プールを読込中…</div>';
    ctrls.innerHTML = '<button class="btn-secondary" id="qskillCloseBtn" type="button">閉じる</button>';
    var lc = document.getElementById('qskillCloseBtn');
    if (lc) lc.addEventListener('click', close);

    loadQSkillPool().then(function (pool) {
      session.pool = pool;
      var saved = loadQSkillProgress(pool);
      var hasResume = !!(saved && saved.currentIndex > 0 && saved.currentIndex < saved.questionOrder.length);
      if (hasResume) {
        // 再開可能
        renderIntro(true);
      } else if (saved && saved.currentIndex >= saved.questionOrder.length) {
        // 出題完了済だが結果未保存 → そのまま結果表示
        session.questionOrder = saved.questionOrder;
        session.answers = saved.answers;
        renderResult();
      } else {
        renderIntro(false);
      }
    }).catch(function (err) {
      if (global.STEADY_DEBUG) console.warn('[qskill] pool load failed:', err);
      renderError('質問プールの読込に失敗しました（' + (err && err.message || err) + '）。ネットワーク接続を確認してください。');
    });
  }
  // -------------------------------------------------------------
  // === Q-SKILL v2 BLOCK 終了 ===
  // -------------------------------------------------------------

  // -------------------------------------------------------------
  // === B8 Run 7（UX-02 / UX-06 / UX-09 / UX-11 / UX-12）BLOCK 開始 ===
  // -------------------------------------------------------------

  // -------------------------------------------------------------
  // R7-A. UX-02 A2HS engagement-trigger
  //   - SteadyUseLog.getStreakDays() を読んで streakDays >= 3
  //     かつ A2HS_DISMISSED === false かつ A2HS_PROMPTED === false で
  //     `<div class="a2hs-banner">` を生成・表示
  //   - 「あとで」「やめる」操作で dismiss 永続化
  //   - standalone 起動中（既に追加済）は出さない
  // -------------------------------------------------------------
  function shouldShowA2HSBanner() {
    try {
      if (isStandalone()) {
        return { show: false, reason: 'standalone' };
      }
      var dismissed = lsGet(LS_V32.A2HS_DISMISSED, false);
      if (dismissed === true) {
        return { show: false, reason: 'dismissed' };
      }
      var prompted = lsGet(LS_V32.A2HS_PROMPTED, false);
      if (prompted === true) {
        return { show: false, reason: 'already-prompted' };
      }
      // SteadyUseLog 経由で streakDays を取得
      var streakDays = 0;
      try {
        if (global.SteadyUseLog && typeof global.SteadyUseLog.getStreakDays === 'function') {
          streakDays = global.SteadyUseLog.getStreakDays();
        }
      } catch (_) {}
      // engagement-trigger 条件（発注書 §1-1）：streakDays >= 3
      if (streakDays >= 3 && lsGet(LS_V32.A2HS_PROMPTED, false) === false) {
        return { show: true, reason: 'engaged', streakDays: streakDays };
      }
      return { show: false, reason: 'not-engaged', streakDays: streakDays };
    } catch (_) {
      return { show: false, reason: 'error' };
    }
  }

  function ensureA2HSBannerDOM() {
    // 3 HTML 共通：body 末尾に動的注入（HTML 側 markup 不要）
    var existing = document.querySelector('.a2hs-banner');
    if (existing) return existing;
    var banner = document.createElement('div');
    banner.className = 'a2hs-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'ホーム画面追加のおすすめ');
    banner.innerHTML = '' +
      '<div class="a2hs-banner-title">ホーム画面に追加すると便利です</div>' +
      '<div class="a2hs-banner-msg">3 日連続で使ってくれてありがとう。ホーム画面に追加すると、毎日サッと開けて、データも残りやすくなります。</div>' +
      '<div class="a2hs-banner-actions">' +
        '<button type="button" class="a2hs-banner-later" aria-label="あとで判断">あとで</button>' +
        '<button type="button" class="a2hs-banner-dismiss" aria-label="今後表示しない">やめる</button>' +
        '<button type="button" class="a2hs-banner-cta">追加方法を見る</button>' +
      '</div>';
    document.body.appendChild(banner);
    return banner;
  }

  function showA2HSBanner() {
    var status = shouldShowA2HSBanner();
    if (!status.show) return false;
    var banner = ensureA2HSBannerDOM();
    if (!banner) return false;
    banner.classList.add('visible');
    // PROMPTED フラグ立て（再表示防止）
    lsSet(LS_V32.A2HS_PROMPTED, true);
    // ボタンイベント
    var laterBtn = banner.querySelector('.a2hs-banner-later');
    var dismissBtn = banner.querySelector('.a2hs-banner-dismiss');
    var ctaBtn = banner.querySelector('.a2hs-banner-cta');
    if (laterBtn) laterBtn.addEventListener('click', function () {
      // 24h スヌーズ：PROMPTED は立てたが DISMISSED は false のまま
      // 次回 streakDays 再判定で出る／立て直し対象は B1 EXPORT_LATER と同等運用
      lsSet(LS_V32.A2HS_PROMPTED, false);
      banner.classList.remove('visible');
      setTimeout(function () { try { banner.parentNode && banner.parentNode.removeChild(banner); } catch (_) {} }, 320);
    });
    if (dismissBtn) dismissBtn.addEventListener('click', function () {
      // やめる：永続 dismiss
      lsSet(LS_V32.A2HS_DISMISSED, true);
      banner.classList.remove('visible');
      setTimeout(function () { try { banner.parentNode && banner.parentNode.removeChild(banner); } catch (_) {} }, 320);
    });
    if (ctaBtn) ctaBtn.addEventListener('click', function () {
      // core 側 a2hsModal があればそれを開く・なければ steady-core.html#a2hs にリダイレクト
      var modal = document.getElementById('a2hsModal');
      if (modal) {
        modal.classList.add('active');
      } else {
        location.href = './steady-core.html#a2hs';
      }
    });
    return true;
  }

  // -------------------------------------------------------------
  // R7-B. UX-09 keyboard shortcut help モーダル
  //   - `?` キーで shortcut-help-modal を表示
  //   - Esc / 外クリック / 閉じるボタンで閉じる
  //   - input focus 中・修飾キー組合せ中は無効化
  //   - aria-modal="true" + role="dialog"
  // -------------------------------------------------------------
  function ensureShortcutHelpModalDOM() {
    var existing = document.querySelector('.shortcut-help-modal');
    if (existing) return existing;
    var modal = document.createElement('div');
    modal.className = 'shortcut-help-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'shortcutHelpTitle');
    modal.innerHTML = '' +
      '<div class="shortcut-help-card" role="document">' +
        '<h3 id="shortcutHelpTitle">キーボードショートカット</h3>' +
        '<dl>' +
          '<dt>Space</dt><dd>再生 / 一時停止</dd>' +
          '<dt>← / →</dt><dd>BPM −1 / +1</dd>' +
          '<dt>1〜8</dt><dd>pattern 1〜8 へ切替</dd>' +
          '<dt>?</dt><dd>このヘルプを開閉</dd>' +
          '<dt>Esc</dt><dd>このヘルプを閉じる</dd>' +
        '</dl>' +
        '<div class="shortcut-help-close-row">' +
          '<button type="button" class="shortcut-help-close" aria-label="ヘルプを閉じる">閉じる</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    // 外クリックで閉じる
    modal.addEventListener('click', function (ev) {
      if (ev.target === modal) closeShortcutHelp();
    });
    var closeBtn = modal.querySelector('.shortcut-help-close');
    if (closeBtn) closeBtn.addEventListener('click', closeShortcutHelp);
    return modal;
  }
  function openShortcutHelp() {
    var modal = ensureShortcutHelpModalDOM();
    if (!modal) return;
    modal.classList.add('visible');
  }
  function closeShortcutHelp() {
    var modal = document.querySelector('.shortcut-help-modal');
    if (modal) modal.classList.remove('visible');
  }
  function isShortcutHelpOpen() {
    var modal = document.querySelector('.shortcut-help-modal');
    return !!(modal && modal.classList.contains('visible'));
  }
  function isInputLikeFocused() {
    try {
      var t = document.activeElement;
      if (!t) return false;
      var tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (t.isContentEditable) return true;
    } catch (_) {}
    return false;
  }
  function attachShortcutListeners() {
    if (global.__steadyShortcutAttached) return; // 多重登録防止
    global.__steadyShortcutAttached = true;
    document.addEventListener('keydown', function (ev) {
      // event/ev 両参照対応（window.event 非対応環境でも動くように local alias）
      var event = ev;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      // `?` キー（Shift+/ on US 配列・直接 `?` キー event）
      if (event.key === '?') {
        if (isInputLikeFocused()) return;
        ev.preventDefault();
        if (isShortcutHelpOpen()) closeShortcutHelp(); else openShortcutHelp();
        return;
      }
      // Esc：help が開いてれば閉じる
      if (ev.key === 'Escape' || ev.key === 'Esc') {
        if (isShortcutHelpOpen()) {
          ev.preventDefault();
          closeShortcutHelp();
          return;
        }
      }
      // help モーダル open 中はキー入力を help にフォーカス
      if (isShortcutHelpOpen()) return;
      if (isInputLikeFocused()) return;
      // Space：play / pause（UX-09 仕様）
      if (event.key === ' ' || ev.key === 'Spacebar') {
        var playBtn = document.querySelector('.emo-play-btn.playing, .emo-play-btn[data-state="playing"]') ||
                      document.querySelector('.emo-play-btn');
        if (playBtn) {
          ev.preventDefault();
          playBtn.click();
          return;
        }
      }
      // ← / →：BPM −1 / +1
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        var dir = (ev.key === 'ArrowRight') ? 1 : -1;
        // 直近 active な emo lab の BPM input を狙う
        var bpmInput = document.querySelector('.emo-lab.active input[type="number"][data-role="bpm"]') ||
                       document.querySelector('input[type="number"][data-role="bpm"]') ||
                       document.querySelector('input.emo-bpm-input');
        if (bpmInput) {
          ev.preventDefault();
          var cur = parseFloat(bpmInput.value || bpmInput.getAttribute('value') || '90');
          if (!isFinite(cur)) cur = 90;
          var next = Math.max(40, Math.min(240, cur + dir));
          bpmInput.value = String(next);
          // change イベントを発火して既存 listener に渡す
          try { bpmInput.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
          try { bpmInput.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
          return;
        }
      }
      // 1〜8：pattern 切替
      if (/^[1-8]$/.test(ev.key)) {
        var idx = parseInt(ev.key, 10);
        var card = document.querySelector('[data-pattern-index="' + idx + '"]') ||
                   document.querySelector('#emo-lab-p' + idx + ' .phase1-pattern-chevron') ||
                   document.querySelector('#emo-lab-p' + idx);
        if (card) {
          ev.preventDefault();
          // クリック可能要素なら click()、それ以外は scrollIntoView
          if (typeof card.click === 'function' && card.tagName !== 'SECTION' && card.tagName !== 'DIV') {
            card.click();
          } else {
            try { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) { card.scrollIntoView(); }
          }
          return;
        }
      }
    });
  }

  // -------------------------------------------------------------
  // R7-C. UX-06 Soundbrenner Parity — TAP tempo + beat-dot
  //   - tapTempo()：4 回タップ平均で BPM 算出
  //   - createBeatDots()：4 個 dot 視覚拍を生成
  // -------------------------------------------------------------
  var __tapTimes = [];
  function tapTempo() {
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    // 2 秒以上開いたら履歴リセット（タップ流れが切れた判定）
    if (__tapTimes.length > 0 && (now - __tapTimes[__tapTimes.length - 1]) > 2000) {
      __tapTimes = [];
    }
    __tapTimes.push(now);
    if (__tapTimes.length > 4) __tapTimes.shift();
    if (__tapTimes.length < 2) return null;
    // 直近 4 回（最大）の間隔の平均から BPM
    var diffs = [];
    for (var i = 1; i < __tapTimes.length; i++) {
      diffs.push(__tapTimes[i] - __tapTimes[i - 1]);
    }
    var avg = diffs.reduce(function (a, b) { return a + b; }, 0) / diffs.length;
    if (avg <= 0) return null;
    var bpm = Math.round(60000 / avg);
    if (bpm < 40 || bpm > 240) return null;
    return bpm;
  }
  function resetTapTempo() { __tapTimes = []; }
  function createBeatDots(container, count) {
    if (!container) return null;
    container.innerHTML = '';
    container.classList.add('beat-dots');
    var n = count || 4;
    for (var i = 0; i < n; i++) {
      var d = document.createElement('span');
      d.className = 'beat-dot' + (i === 0 ? ' downbeat' : '');
      d.setAttribute('data-beat', String(i));
      d.setAttribute('aria-hidden', 'true');
      container.appendChild(d);
    }
    return container;
  }
  function setActiveBeatDot(container, beatIndex) {
    if (!container) return;
    var dots = container.querySelectorAll('.beat-dot');
    dots.forEach(function (d, i) { d.classList.toggle('active', i === beatIndex); });
  }

  // -------------------------------------------------------------
  // R7-D. UX-11 LocalStorage 14 日連続未使用 警告
  //   - SteadyUseLog.getState().lastSessionDate を見て 14 日経過なら表示
  //   - 24 時間以内に dismiss されたら抑制
  // -------------------------------------------------------------
  function shouldShowStaleWarn() {
    try {
      var lastSessionDate = null;
      var streakDays = 0;
      if (global.SteadyUseLog && typeof global.SteadyUseLog.getState === 'function') {
        var st = global.SteadyUseLog.getState();
        lastSessionDate = st.lastSessionDate;
        streakDays = st.streakDays || 0;
      }
      if (!lastSessionDate) {
        return { show: false, reason: 'no-last-session' };
      }
      // YMD 文字列を date に
      var parts = String(lastSessionDate).split('-');
      if (parts.length !== 3) return { show: false, reason: 'bad-format' };
      var lastDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      var diffMs = Date.now() - lastDate.getTime();
      var diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
      // 14 日チェック（発注書 §1-5：14 日連続未使用 = streakDays === 0 && lastSessionDate < 14日前）
      if (streakDays === 0 && diffDays >= 14) {
        // 24h スヌーズ判定
        var dismissed = lsGet(LS_V32.STALE_WARN_DISMISSED, null);
        if (typeof dismissed === 'number' && (Date.now() - dismissed) < (24 * 60 * 60 * 1000)) {
          return { show: false, reason: 'snoozed', diffDays: diffDays };
        }
        return { show: true, reason: 'stale', diffDays: diffDays };
      }
      return { show: false, reason: 'recent', diffDays: diffDays };
    } catch (_) {
      return { show: false, reason: 'error' };
    }
  }
  function attachStaleWarnBanner() {
    try {
      var status = shouldShowStaleWarn();
      var el = document.getElementById('staleWarnBanner');
      if (!el) return false;
      if (!status.show) {
        el.classList.remove('visible');
        return false;
      }
      el.innerHTML = '' +
        '<strong>⚠️ ' + status.diffDays + ' 日連続でアクセスがありません</strong><br>' +
        'iPhone Safari の仕様で、長期間アプリを使わないとデータが消える可能性があります。' +
        '<button type="button" id="staleWarnExportBtn" style="margin-top:8px; margin-right:8px;">JSON エクスポート</button>' +
        '<button type="button" id="staleWarnDismissBtn" style="margin-top:8px;">24h 後に再表示</button>';
      el.classList.add('visible');
      var exportBtn = document.getElementById('staleWarnExportBtn');
      var dismissBtn = document.getElementById('staleWarnDismissBtn');
      if (exportBtn) exportBtn.addEventListener('click', function () { downloadJSONExport(); });
      if (dismissBtn) dismissBtn.addEventListener('click', function () {
        lsSet(LS_V32.STALE_WARN_DISMISSED, Date.now());
        el.classList.remove('visible');
      });
      return true;
    } catch (_) { return false; }
  }

  // -------------------------------------------------------------
  // R7-E. 起動シーケンス hook（bootShared 拡張）
  //   - DOMContentLoaded 後の deferred 起動（A2HS engagement / shortcut listener / stale warn）
  // -------------------------------------------------------------
  function bootRun7() {
    try { attachShortcutListeners(); } catch (_) {}
    // P13 SteadyUseLog の load を待ってから A2HS / stale warn 判定
    setTimeout(function () {
      try { showA2HSBanner(); } catch (_) {}
      try { attachStaleWarnBanner(); } catch (_) {}
    }, 1500);
  }

  // -------------------------------------------------------------
  // === B8 Run 7 BLOCK 終了 ===
  // -------------------------------------------------------------

  // -------------------------------------------------------------
  // 17. 公開 API（global.SteadyShared）
  // -------------------------------------------------------------
  global.SteadyShared = {
    LS_V32: LS_V32,
    LEGACY_KEYS: LEGACY_KEYS,
    lsGet: lsGet,
    lsSet: lsSet,
    lsRemove: lsRemove,
    migrateToV3_2: migrateToV3_2,
    migrateGameState: migrateGameState,
    migrateGameStateOnBoot: migrateGameStateOnBoot,
    forceServiceWorkerCleanupOnce_v3_2: forceServiceWorkerCleanupOnce_v3_2,
    registerPhysicalSW: registerPhysicalSW,
    isStandalone: isStandalone,
    isIOSSafari: isIOSSafari,
    isLikelyEU: isLikelyEU,
    requestPersistIfNeeded: requestPersistIfNeeded,
    applyTheme: applyTheme,
    toggleTheme: toggleTheme,
    markActiveNav: markActiveNav,
    getStorageEstimate: getStorageEstimate,
    exportAllToJSON: exportAllToJSON,
    downloadJSONExport: downloadJSONExport,
    shouldShowExportWarn: shouldShowExportWarn,
    summarizeStoredData: summarizeStoredData,
    getA2HSDoneStatus: getA2HSDoneStatus,
    ensureFirstSeen: ensureFirstSeen,
    attachBackupUI: attachBackupUI,
    // Q-SKILL v2 (B2)
    loadQSkillPool: loadQSkillPool,
    buildQSkillQuestionSet: buildQSkillQuestionSet,
    scoreQSkill: scoreQSkill,
    saveQSkillProgress: saveQSkillProgress,
    loadQSkillProgress: loadQSkillProgress,
    clearQSkillProgress: clearQSkillProgress,
    saveQSkillResult: saveQSkillResult,
    getQSkillResult: getQSkillResult,
    getQSkillRecommendation: getQSkillRecommendation,
    startQSkillModal: startQSkillModal,
    // B8 Run 7（UX-02 / UX-06 / UX-09 / UX-11）公開 API
    shouldShowA2HSBanner: shouldShowA2HSBanner,
    showA2HSBanner: showA2HSBanner,
    openShortcutHelp: openShortcutHelp,
    closeShortcutHelp: closeShortcutHelp,
    attachShortcutListeners: attachShortcutListeners,
    tapTempo: tapTempo,
    resetTapTempo: resetTapTempo,
    createBeatDots: createBeatDots,
    setActiveBeatDot: setActiveBeatDot,
    shouldShowStaleWarn: shouldShowStaleWarn,
    attachStaleWarnBanner: attachStaleWarnBanner,
    bootShared: bootShared,
    version: 'v3.3.0-block9-h1'
  };

  // P12（EMP002 PRE-AUDIT §2-6）：SteadyShared.currentBpm を読み取り専用 getter として export
  //   - 内部 source は window.__steadyBpm（既存実装の値を尊重）
  //   - 不正値・未設定時は 90 を fallback（DEFAULT_BPM 同値）
  //   - steady-beat-wheel.js L365-367 で `global.SteadyShared.currentBpm` を参照する経路を有効化
  try {
    Object.defineProperty(global.SteadyShared, 'currentBpm', {
      get: function () {
        var v = global.__steadyBpm;
        return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 90;
      },
      enumerable: true,
      configurable: false
    });
  } catch (_) { /* defineProperty 失敗時は読み取り不可のまま（壊さない） */ }

  // 自動起動（DOM ready 後）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootShared);
  } else {
    bootShared();
  }
})(typeof window !== 'undefined' ? window : globalThis);
