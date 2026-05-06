/* =============================================================
   STEADY v3.3.0r1 hotfix — steady-self-report.js（自己申告練習記録）
   発注書：00_社内システム/06_AI運用台帳/発注書/2026-05-07_AL007_steady_v3.3.0r1_practice_xp_hotfix.md

   目的：
     V4-XP-A2「自己申告フォーム」LS バックエンド。
     ユーザーが「スタジオ／ライブ／自宅セット／練習パッド／その他」で練習した時間を
     入力すると entries[] に push され、未チャージ entries について
     SteadyGame.gainXP/gainCoins（または steady.html monolithic addXp）を呼ぶ。

   設計原則：
     - 単一 IIFE で window.SteadySelfReport のみ公開
     - 衝突回避ガード（既存 SteadySelfReport があれば return）
     - localStorage キーは _v3_3 名前空間（steady_self_practice_v3_3）
     - 既存 LS キー（XP/coins/level/equipment/titles/sessions）には触らない
     - 自動加算は state.lastChargeAt で冪等性確保（差分のみ加算）
     - SteadyGame が存在すればそちら経由で XP/コイン加算
     - 存在しない場合（steady.html monolithic 環境）は window.addXp + 内部 totals で代替

   公開 API（発注書 §2-1）：
     window.SteadySelfReport = {
       __version,
       addEntry({category, minutes, memo}),
       getEntries(daysBack),
       getDailyTotalMinutes(daysBack),
       getCategoryBreakdown(daysBack),
       getStreakDays(),
       getCumulative(),
       chargeUnclaimedSelfReports()
     };

   厳守事項：
     - 5 カテゴリ：studio / live / home_kit / practice_pad / other
     - 上限なし（minutes に max 制限なし・min=1 のみ）
     - メモ 200 字（呼出側で maxlength=200 を強制）
     - 換算：30 秒 = 5 XP / 2 コイン（chargeFromPractice と同レート）
   ============================================================= */

(function (global) {
  'use strict';

  // -------------------------------------------------------------
  // 0. 衝突回避ガード（並列 dispatch 互換）
  // -------------------------------------------------------------
  if (global.SteadySelfReport && global.SteadySelfReport.__version) {
    if (global.STEADY_DEBUG) console.warn('[steady-self-report] already loaded:', global.SteadySelfReport.__version);
    return;
  }

  // -------------------------------------------------------------
  // 1. 定数
  // -------------------------------------------------------------
  var LS_KEY = 'steady_self_practice_v3_3';
  var SCHEMA_VERSION = 1;
  var VALID_CATEGORIES = { studio: true, live: true, home_kit: true, practice_pad: true, other: true };
  // 換算：30 秒 = 5 XP / 2 コイン（steady-game.js XP_GAIN.perPracticeSec30 と同レート）
  var XP_PER_30SEC = 5;
  var COIN_PER_30SEC = 2;

  // -------------------------------------------------------------
  // 2. localStorage 安全ラッパ
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
  function daysAgoYMD(daysBack) {
    var d = new Date();
    d.setDate(d.getDate() - daysBack);
    return ymd(d);
  }

  // -------------------------------------------------------------
  // 4. state ロード／セーブ（MG-1：欠損時は default 補完で初期化）
  // -------------------------------------------------------------
  function defaultState() {
    return {
      schema_version: SCHEMA_VERSION,
      entries: [],
      lastChargeAt: 0,
      // steady.html monolithic 環境用：SteadyGame が無い時の累計
      monolithicTotalXp: 0,
      monolithicTotalCoin: 0
    };
  }
  function loadState() {
    var s = lsGet(LS_KEY, null);
    if (!s || typeof s !== 'object') {
      return defaultState();
    }
    if (typeof s.schema_version !== 'number') s.schema_version = SCHEMA_VERSION;
    if (!Array.isArray(s.entries)) s.entries = [];
    if (typeof s.lastChargeAt !== 'number') s.lastChargeAt = 0;
    if (typeof s.monolithicTotalXp !== 'number') s.monolithicTotalXp = 0;
    if (typeof s.monolithicTotalCoin !== 'number') s.monolithicTotalCoin = 0;
    return s;
  }
  function saveState(s) {
    return lsSet(LS_KEY, s);
  }

  // -------------------------------------------------------------
  // 5. ID 生成（衝突回避：時刻 + 乱数）
  // -------------------------------------------------------------
  function makeId() {
    return 'sp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // -------------------------------------------------------------
  // 6. 換算（minutes → xp / coin）
  // -------------------------------------------------------------
  function calcReward(minutes) {
    if (typeof minutes !== 'number' || minutes <= 0) return { xp: 0, coin: 0 };
    var sec = Math.floor(minutes * 60);
    var units = Math.floor(sec / 30);
    return { xp: units * XP_PER_30SEC, coin: units * COIN_PER_30SEC };
  }

  // -------------------------------------------------------------
  // 7. 環境差吸収：XP / コインを実際にゲーム state に加算
  //    SteadyGame があれば優先、無ければ steady.html monolithic addXp
  // -------------------------------------------------------------
  function applyXpAndCoin(addXp, addCoin) {
    var applied = { xp: 0, coin: 0, via: 'none' };
    if (addXp <= 0 && addCoin <= 0) return applied;

    // 経路 A：SteadyGame（steady-game.html / steady-core.html / steady-ear.html）
    if (global.SteadyGame &&
        typeof global.SteadyGame.loadState === 'function' &&
        typeof global.SteadyGame.gainXP === 'function' &&
        typeof global.SteadyGame.gainCoins === 'function' &&
        typeof global.SteadyGame.saveState === 'function') {
      try {
        var gs = global.SteadyGame.loadState();
        if (addXp > 0) global.SteadyGame.gainXP(gs, addXp);
        if (addCoin > 0) global.SteadyGame.gainCoins(gs, addCoin);
        global.SteadyGame.saveState(gs);
        applied.xp = addXp;
        applied.coin = addCoin;
        applied.via = 'SteadyGame';
        return applied;
      } catch (_) { /* fallback to monolithic */ }
    }

    // 経路 B：steady.html monolithic（addXp グローバル関数）
    if (typeof global.addXp === 'function') {
      try {
        if (addXp > 0) global.addXp(addXp);
        // monolithic は coin 概念なし → 内部累計のみ保持（UI 表示用）
        var st = loadState();
        st.monolithicTotalXp = (st.monolithicTotalXp || 0) + addXp;
        st.monolithicTotalCoin = (st.monolithicTotalCoin || 0) + addCoin;
        saveState(st);
        applied.xp = addXp;
        applied.coin = addCoin;
        applied.via = 'monolithic';
        return applied;
      } catch (_) {}
    }

    // 経路 C：どちらも無い → 累計だけ内部保持（fail-safe）
    var st2 = loadState();
    st2.monolithicTotalXp = (st2.monolithicTotalXp || 0) + addXp;
    st2.monolithicTotalCoin = (st2.monolithicTotalCoin || 0) + addCoin;
    saveState(st2);
    applied.xp = addXp;
    applied.coin = addCoin;
    applied.via = 'fallback';
    return applied;
  }

  // -------------------------------------------------------------
  // 8. addEntry（自己申告）
  //    返値：{ ok:true, id, addXp, addCoin } または { ok:false, reason }
  // -------------------------------------------------------------
  function addEntry(input) {
    if (!input || typeof input !== 'object') return { ok: false, reason: 'invalid-input' };
    var category = input.category;
    var minutes = Number(input.minutes);
    var memo = typeof input.memo === 'string' ? input.memo : '';

    if (!VALID_CATEGORIES[category]) return { ok: false, reason: 'invalid-category' };
    if (!isFinite(minutes) || minutes < 1) return { ok: false, reason: 'invalid-minutes' };
    minutes = Math.floor(minutes);
    if (memo.length > 200) memo = memo.slice(0, 200); // 安全側で切詰め

    var now = Date.now();
    var entry = {
      id: makeId(),
      date: todayYMD(),
      ts: now,
      category: category,
      minutes: minutes,
      memo: memo,
      charged: false,
      chargedAt: 0
    };

    var state = loadState();
    state.entries.push(entry);
    saveState(state);

    // 即時加算（A2-4：記録ボタンクリックで即時 XP/コイン加算）
    var reward = calcReward(minutes);
    var applied = applyXpAndCoin(reward.xp, reward.coin);

    // entry を charged 状態に更新
    var st2 = loadState();
    for (var i = 0; i < st2.entries.length; i++) {
      if (st2.entries[i].id === entry.id) {
        st2.entries[i].charged = true;
        st2.entries[i].chargedAt = Date.now();
        break;
      }
    }
    st2.lastChargeAt = Date.now();
    saveState(st2);

    return { ok: true, id: entry.id, addXp: reward.xp, addCoin: reward.coin, via: applied.via };
  }

  // -------------------------------------------------------------
  // 9. getEntries（直近 N 日分）
  // -------------------------------------------------------------
  function getEntries(daysBack) {
    var n = (typeof daysBack === 'number' && daysBack > 0) ? Math.floor(daysBack) : 30;
    var fromDate = daysAgoYMD(n - 1);
    var state = loadState();
    return (state.entries || []).filter(function (e) {
      return e && e.date && e.date >= fromDate;
    }).slice();
  }

  // -------------------------------------------------------------
  // 10. getDailyTotalMinutes（直近 N 日の日次合計）
  //     自己申告 + SteadyUseLog の app-time（duration_ms）を合算
  //     返値：[{date:'YYYY-MM-DD', totalMinutes:N, selfMin:N, appMin:N}, ...]（古→新）
  // -------------------------------------------------------------
  function getDailyTotalMinutes(daysBack) {
    var n = (typeof daysBack === 'number' && daysBack > 0) ? Math.floor(daysBack) : 30;
    var byDate = {};
    var i, d;
    for (i = n - 1; i >= 0; i--) {
      d = daysAgoYMD(i);
      byDate[d] = { date: d, totalMinutes: 0, selfMin: 0, appMin: 0 };
    }
    // 自己申告
    var entries = getEntries(n);
    entries.forEach(function (e) {
      if (byDate[e.date]) {
        byDate[e.date].selfMin += (e.minutes || 0);
        byDate[e.date].totalMinutes += (e.minutes || 0);
      }
    });
    // SteadyUseLog（app-time）
    if (global.SteadyUseLog && typeof global.SteadyUseLog.getDailyUseCount === 'function') {
      try {
        var rows = global.SteadyUseLog.getDailyUseCount(n) || [];
        rows.forEach(function (r) {
          if (r && r.date && byDate[r.date]) {
            var min = Math.floor((r.duration_ms || 0) / 60000);
            byDate[r.date].appMin = min;
            byDate[r.date].totalMinutes += min;
          }
        });
      } catch (_) {}
    }
    // 古→新で配列化
    var result = [];
    for (i = n - 1; i >= 0; i--) {
      d = daysAgoYMD(i);
      result.push(byDate[d]);
    }
    return result;
  }

  // -------------------------------------------------------------
  // 11. getCategoryBreakdown（直近 N 日のカテゴリ別合計分）
  //     5 カテゴリ + app_time（SteadyUseLog 合算）の 6 セグメント
  // -------------------------------------------------------------
  function getCategoryBreakdown(daysBack) {
    var n = (typeof daysBack === 'number' && daysBack > 0) ? Math.floor(daysBack) : 30;
    var result = { studio: 0, live: 0, home_kit: 0, practice_pad: 0, other: 0, app_time: 0 };
    var entries = getEntries(n);
    entries.forEach(function (e) {
      if (result.hasOwnProperty(e.category)) {
        result[e.category] += (e.minutes || 0);
      }
    });
    // app-time
    if (global.SteadyUseLog && typeof global.SteadyUseLog.getDailyUseCount === 'function') {
      try {
        var rows = global.SteadyUseLog.getDailyUseCount(n) || [];
        var totalMs = 0;
        rows.forEach(function (r) { if (r) totalMs += (r.duration_ms || 0); });
        result.app_time = Math.floor(totalMs / 60000);
      } catch (_) {}
    }
    return result;
  }

  // -------------------------------------------------------------
  // 12. getStreakDays（自己申告 OR app-time のいずれかで該当日カウント）
  //     当日に練習がなくても、前日まで連続していれば streak は維持
  //     （UI 側で "本日 0 分" の警告を出す責務は呼出側）
  // -------------------------------------------------------------
  function getStreakDays() {
    // 直近 60 日まで遡って streak 計算（実用上十分）
    var rows = getDailyTotalMinutes(60);
    if (!rows || rows.length === 0) return 0;
    // rows は古→新。最新から逆順に走査
    var streak = 0;
    var allowGap = true; // 当日 0 分でも streak は維持（前日まで連続なら）
    for (var i = rows.length - 1; i >= 0; i--) {
      var min = rows[i].totalMinutes || 0;
      if (min > 0) {
        streak++;
        allowGap = false;
      } else {
        if (allowGap) {
          // 当日のみゼロは許容（連続維持）
          allowGap = false;
          continue;
        }
        break;
      }
    }
    return streak;
  }

  // -------------------------------------------------------------
  // 13. getCumulative（累計サマリ）
  //     自己申告全件 + app-time 全件の合算
  // -------------------------------------------------------------
  function getCumulative() {
    var state = loadState();
    var totalMinutes = 0;
    var totalXp = 0;
    var totalCoin = 0;
    (state.entries || []).forEach(function (e) {
      totalMinutes += (e.minutes || 0);
      var r = calcReward(e.minutes || 0);
      totalXp += r.xp;
      totalCoin += r.coin;
    });
    // app-time（自己申告と独立）
    if (global.SteadyUseLog && typeof global.SteadyUseLog.getDailyUseCount === 'function') {
      try {
        var rows = global.SteadyUseLog.getDailyUseCount(60) || [];
        var ms = 0;
        rows.forEach(function (r) { if (r) ms += (r.duration_ms || 0); });
        var appMin = Math.floor(ms / 60000);
        var sec = Math.floor(ms / 1000);
        var units = Math.floor(sec / 30);
        totalMinutes += appMin;
        totalXp += units * XP_PER_30SEC;
        totalCoin += units * COIN_PER_30SEC;
      } catch (_) {}
    }
    return { totalMinutes: totalMinutes, totalXp: totalXp, totalCoin: totalCoin };
  }

  // -------------------------------------------------------------
  // 14. chargeUnclaimedSelfReports（自動加算 hook 用）
  //     entry.charged === false の entries を SteadyGame に流し込み
  //     冪等性：addEntry 経由で記録した entries は charged=true になっているため、
  //     ここでは「過去 LS にあったが何らかの理由で未チャージの entries」を救済する役割
  // -------------------------------------------------------------
  function chargeUnclaimedSelfReports() {
    var state = loadState();
    var pending = (state.entries || []).filter(function (e) { return e && !e.charged; });
    if (pending.length === 0) {
      return { ok: true, charged: 0, addXp: 0, addCoin: 0 };
    }
    var totalXp = 0;
    var totalCoin = 0;
    pending.forEach(function (e) {
      var r = calcReward(e.minutes || 0);
      totalXp += r.xp;
      totalCoin += r.coin;
    });
    var applied = applyXpAndCoin(totalXp, totalCoin);
    // entries を charged 状態に更新
    var st2 = loadState();
    var now = Date.now();
    st2.entries.forEach(function (e) {
      if (e && !e.charged) {
        e.charged = true;
        e.chargedAt = now;
      }
    });
    st2.lastChargeAt = now;
    saveState(st2);
    return { ok: true, charged: pending.length, addXp: totalXp, addCoin: totalCoin, via: applied.via };
  }

  // -------------------------------------------------------------
  // 15. 公開 API
  // -------------------------------------------------------------
  global.SteadySelfReport = {
    __version: 'v3.3.0r1-block9-h2',
    addEntry: addEntry,
    getEntries: getEntries,
    getDailyTotalMinutes: getDailyTotalMinutes,
    getCategoryBreakdown: getCategoryBreakdown,
    getStreakDays: getStreakDays,
    getCumulative: getCumulative,
    chargeUnclaimedSelfReports: chargeUnclaimedSelfReports,
    // 内部公開（テスト/監査用）
    _internal: {
      LS_KEY: LS_KEY,
      SCHEMA_VERSION: SCHEMA_VERSION,
      VALID_CATEGORIES: VALID_CATEGORIES,
      XP_PER_30SEC: XP_PER_30SEC,
      COIN_PER_30SEC: COIN_PER_30SEC,
      todayYMD: todayYMD,
      daysAgoYMD: daysAgoYMD,
      loadState: loadState,
      saveState: saveState,
      calcReward: calcReward,
      applyXpAndCoin: applyXpAndCoin
    }
  };

  // -------------------------------------------------------------
  // 16. MG-1：起動時に LS が無ければ default state を初期化（読み込み副作用）
  // -------------------------------------------------------------
  try {
    var initial = lsGet(LS_KEY, null);
    if (!initial || typeof initial !== 'object') {
      saveState(defaultState());
    }
  } catch (_) {}
})(typeof window !== 'undefined' ? window : globalThis);
