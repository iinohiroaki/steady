/* =============================================================
   STEADY v3.2.0r2 - B13 Mitscherlich 停滞検知モジュール
   ファイル: steady-stagnation.js
   実装者: AL007 井上ドーナツ #5号（並列実装）
   生成日: 2026-05-06
   著者欄: 実Agent（Task tool 経由・AL007 ペルソナ並列起動）
   監査: 未経由（実装直後）→ AL011/AL012/EMP002 並列監査予定
   ----
   役割：
     1. Mitscherlich 漸近成長曲線 y = a(1 - e^(-bx)) でスキル成長を fit
     2. 3-condition AND 停滞検知：
          ① 直近 7 日の伸び率 < 閾値（asymptote 比 0.5%）
          ② 直近 14 日 wobble_ms 平均 ≧ 30 日平均
          ③ 連続練習日数（コミット率）が閾値以下（直近14日中 ≦7日）
     3. SDT (Self-Determination Theory) Autonomy / Competence / Relatedness
        の 3 軸でフィードバック文言を生成
     4. 停滞判定時：B12 stagnation テンプレ起動信号（onStagnationDetected）
        ＝ D3 助言エンジン起動信号を発火
   公開：
     window.SteadyStagnation = {
       evaluate(skillHistory),
       getPrescription(stagnationType),
       fitCurve(dataset)
     }
   並走互換：
     window.SteadyCore_B13.evaluateStagnation()  // spec JSON 互換 alias
   依存：
     - steady-shared.js（lsGet/lsSet・LS_V32）
     - steady-coaching-templates.json（B12 経由・存在しない場合は internal SDT 文言で fallback）
     - localStorage steady_bpm_log_v3_2（B4/B5/B6/B11 が記録）
   ============================================================= */

(function (global) {
  'use strict';

  // -------------------------------------------------------------
  // 0. 定数・閾値（AL011 監査用に head 部集約）
  // -------------------------------------------------------------
  var V = 'v3.2.0r2-B13';

  // localStorage キー（既存 LS_V32 名前空間に追従）
  var LS_KEYS = {
    BPM_LOG: 'steady_bpm_log_v3_2',                          // B4/B5/B6/B11 が書き込む実績ログ
    LAST_EVAL_AT: 'steady_stagnation_lastEvaluatedAt_v3_2',  // 24h 1回タイマー
    DECISIONS: 'steady_stagnation_decisions_v3_2',           // ユーザー処方選択履歴
    LAST_FIRE_AT: 'steady_stagnation_lastFireAt_v3_2',       // cooldown 開始点
    FIT_CACHE: 'steady_stagnation_fit_cache_v3_2'            // fitCurve 結果キャッシュ
  };

  // 停滞判定 3条件（発注タスク定義）
  var THRESHOLDS = {
    GROWTH_RATIO_7D: 0.005,      // 直近7日 BPM 成長 / asymptote が 0.5% 以下なら ① TRUE
    WOBBLE_RATIO_14D_30D: 1.00,  // 14日wobble平均 ≧ 30日wobble平均 なら ② TRUE
    PRACTICE_DAYS_14D: 7,        // 直近14日中 練習日 ≦ 7日 なら ③ TRUE（コミット率50%未満）
    COOLDOWN_DAYS: 7,            // 連発防止
    MIN_LOG_DAYS: 14,            // 14日未満は insufficient_data
    INACTIVE_DAYS: 7             // 直近7日に記録 0 → inactive
  };

  // Mitscherlich fit パラメータ初期値・反復条件
  var FIT_PARAMS = {
    A_INIT_MARGIN: 1.10,   // 観測最大値 × 1.10 を a 初期値
    B_INIT: 0.05,          // b 初期値（成長率）
    MAX_ITER: 200,         // Gauss-Newton 反復上限
    TOL: 1e-6,             // 収束許容
    LAMBDA_INIT: 1e-3      // Levenberg-Marquardt damping 初期値
  };

  // -------------------------------------------------------------
  // 1. データ取得＆前処理
  // -------------------------------------------------------------
  function lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch (_) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }

  function nowMs() { return Date.now(); }
  function dayMs() { return 24 * 60 * 60 * 1000; }

  /**
   * skillHistory: Array<{ts:number, pattern_id?:string, bpm?:number,
   *                      wobble_mean_ms?:number, wobble_sd_ms?:number, source?:string}>
   * 引数が省略されたら LS から自前で取り出す。
   */
  function loadHistory(skillHistory) {
    if (Array.isArray(skillHistory)) return skillHistory.slice();
    var fromLS = lsGet(LS_KEYS.BPM_LOG, []);
    return Array.isArray(fromLS) ? fromLS.slice() : [];
  }

  function filterByWindow(logs, days) {
    var cutoff = nowMs() - days * dayMs();
    return logs.filter(function (e) { return e && typeof e.ts === 'number' && e.ts >= cutoff; });
  }

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function uniquePracticeDays(logs) {
    var set = {};
    for (var i = 0; i < logs.length; i++) set[dayKey(logs[i].ts)] = true;
    return Object.keys(set).length;
  }

  function avg(arr) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function stdDev(arr) {
    if (arr.length < 2) return 0;
    var m = avg(arr);
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(s / arr.length);
  }

  // -------------------------------------------------------------
  // 2. Mitscherlich curve fit  y = a(1 - e^(-b x))
  //    Levenberg-Marquardt 法（外部依存なし・bare metal 実装）
  // -------------------------------------------------------------
  /**
   * dataset: Array<{x:number(day index from first record), y:number(bpm or perf metric)}>
   * 戻り値: { a, b, rmse, iterations, converged, asymptote, halfTimeDays }
   *   a = 漸近上限（理論上到達できる最大値）
   *   b = 成長速度（大きいほど早く asymptote に近づく）
   *   asymptote = a の別名
   *   halfTimeDays = a の半分到達日数 = ln(2)/b
   */
  function fitCurve(dataset) {
    if (!Array.isArray(dataset) || dataset.length < 3) {
      return {
        a: 0, b: 0, rmse: NaN, iterations: 0, converged: false,
        asymptote: 0, halfTimeDays: NaN, reason: 'insufficient-points'
      };
    }
    // 入力サニタイズ
    var pts = dataset.filter(function (p) {
      return p && isFinite(p.x) && isFinite(p.y) && p.y >= 0;
    });
    if (pts.length < 3) {
      return {
        a: 0, b: 0, rmse: NaN, iterations: 0, converged: false,
        asymptote: 0, halfTimeDays: NaN, reason: 'insufficient-valid-points'
      };
    }

    // 初期値：a = max*1.10、b = 0.05
    var yMax = -Infinity;
    for (var i = 0; i < pts.length; i++) if (pts[i].y > yMax) yMax = pts[i].y;
    var a = (yMax > 0 ? yMax : 1) * FIT_PARAMS.A_INIT_MARGIN;
    var b = FIT_PARAMS.B_INIT;

    var lambda = FIT_PARAMS.LAMBDA_INIT;
    var prevSSE = computeSSE(pts, a, b);
    var converged = false;
    var iter = 0;

    for (iter = 0; iter < FIT_PARAMS.MAX_ITER; iter++) {
      // Jacobian J: [df/da, df/db]
      // f = a(1 - e^(-bx))
      // df/da = 1 - e^(-bx)
      // df/db = a * x * e^(-bx)
      var JtJ_aa = 0, JtJ_ab = 0, JtJ_bb = 0;
      var Jtr_a = 0, Jtr_b = 0;

      for (var k = 0; k < pts.length; k++) {
        var x = pts[k].x;
        var y = pts[k].y;
        var ebx = Math.exp(-b * x);
        var f = a * (1 - ebx);
        var r = y - f;
        var dfa = 1 - ebx;
        var dfb = a * x * ebx;

        JtJ_aa += dfa * dfa;
        JtJ_ab += dfa * dfb;
        JtJ_bb += dfb * dfb;
        Jtr_a  += dfa * r;
        Jtr_b  += dfb * r;
      }

      // (JtJ + lambda*diag(JtJ)) * delta = Jtr
      var H_aa = JtJ_aa * (1 + lambda);
      var H_bb = JtJ_bb * (1 + lambda);
      var H_ab = JtJ_ab;
      var det = H_aa * H_bb - H_ab * H_ab;
      if (!isFinite(det) || Math.abs(det) < 1e-20) {
        // 特異 → lambda を増やしてリトライ
        lambda *= 10;
        if (lambda > 1e10) break;
        continue;
      }
      var dA = ( H_bb * Jtr_a - H_ab * Jtr_b) / det;
      var dB = (-H_ab * Jtr_a + H_aa * Jtr_b) / det;

      var aTry = a + dA;
      var bTry = b + dB;
      // 物理制約：a > 0, b > 0
      if (aTry <= 0 || bTry <= 0) {
        lambda *= 10;
        if (lambda > 1e10) break;
        continue;
      }
      var newSSE = computeSSE(pts, aTry, bTry);
      if (newSSE < prevSSE) {
        // 採用
        a = aTry; b = bTry;
        var improvement = prevSSE - newSSE;
        prevSSE = newSSE;
        lambda /= 10;
        if (improvement < FIT_PARAMS.TOL) { converged = true; break; }
      } else {
        // 棄却 → lambda 増やして再試行
        lambda *= 10;
        if (lambda > 1e10) break;
      }
    }

    var rmse = Math.sqrt(prevSSE / pts.length);
    return {
      a: a,
      b: b,
      rmse: rmse,
      iterations: iter,
      converged: converged,
      asymptote: a,
      halfTimeDays: b > 0 ? Math.log(2) / b : NaN
    };
  }

  function computeSSE(pts, a, b) {
    var s = 0;
    for (var i = 0; i < pts.length; i++) {
      var f = a * (1 - Math.exp(-b * pts[i].x));
      var r = pts[i].y - f;
      s += r * r;
    }
    return s;
  }

  // 履歴ログを fit 用 dataset に変換（日次平均）
  function logsToFitDataset(logs) {
    if (!logs.length) return [];
    // 日ごとに平均 BPM を集計
    var byDay = {};
    var minTs = Infinity;
    for (var i = 0; i < logs.length; i++) {
      var e = logs[i];
      if (!e || typeof e.ts !== 'number' || typeof e.bpm !== 'number') continue;
      var k = dayKey(e.ts);
      if (!byDay[k]) byDay[k] = { sum: 0, n: 0, ts: e.ts };
      byDay[k].sum += e.bpm;
      byDay[k].n += 1;
      if (e.ts < minTs) minTs = e.ts;
    }
    if (minTs === Infinity) return [];
    var keys = Object.keys(byDay).sort(function (a, b) { return byDay[a].ts - byDay[b].ts; });
    var out = [];
    for (var j = 0; j < keys.length; j++) {
      var d = byDay[keys[j]];
      var dayIdx = Math.floor((d.ts - minTs) / dayMs());
      out.push({ x: dayIdx, y: d.sum / d.n });
    }
    return out;
  }

  // -------------------------------------------------------------
  // 3. 3条件 AND 停滞検知
  // -------------------------------------------------------------
  /**
   * skillHistory 省略可（省略時は LS_KEYS.BPM_LOG から取得）
   * 戻り値:
   * {
   *   status: 'fired' | 'no_fire' | 'insufficient_data' | 'inactive' | 'cooldown',
   *   conditions: { A:bool, B:bool, C:bool },
   *   metrics: { ... 計算値 ... },
   *   fit: { a, b, rmse, ... },
   *   prescription?: { ... fired 時のみ ... },
   *   ctx?: { ... B12 onStagnationDetected 引数 ... }
   * }
   */
  function evaluate(skillHistory) {
    var logs = loadHistory(skillHistory);
    if (!logs.length || logs.length < THRESHOLDS.MIN_LOG_DAYS) {
      return {
        status: 'insufficient_data',
        conditions: { A: false, B: false, C: false },
        metrics: { logs_count: logs.length, min_required: THRESHOLDS.MIN_LOG_DAYS },
        fit: null
      };
    }

    var logs7  = filterByWindow(logs, 7);
    var logs14 = filterByWindow(logs, 14);
    var logs30 = filterByWindow(logs, 30);

    // 直近7日に記録 0 → inactive（停滞ではなくサボり）
    if (logs7.length === 0) {
      return {
        status: 'inactive',
        conditions: { A: false, B: false, C: false },
        metrics: { logs7: 0 },
        fit: null
      };
    }

    // cooldown チェック
    var lastFire = lsGet(LS_KEYS.LAST_FIRE_AT, 0);
    if (lastFire && (nowMs() - lastFire) < THRESHOLDS.COOLDOWN_DAYS * dayMs()) {
      return {
        status: 'cooldown',
        conditions: { A: false, B: false, C: false },
        metrics: { lastFireAt: lastFire, cooldownDays: THRESHOLDS.COOLDOWN_DAYS },
        fit: null
      };
    }

    // === Mitscherlich fit（30日窓） ===
    var fitDataset = logsToFitDataset(logs30.length >= 14 ? logs30 : logs14);
    var fit = fitCurve(fitDataset);
    var asymptote = fit.asymptote || 0;

    // === 条件 A：直近7日の伸び率 < 閾値 ===
    // 直近7日 BPM 平均 - 直近14日 BPM 平均 を asymptote で正規化
    var bpm7  = avg(logs7.map(function (e) { return e.bpm; }).filter(isFinite));
    var bpm14 = avg(logs14.map(function (e) { return e.bpm; }).filter(isFinite));
    var growthRatio = asymptote > 0 ? Math.abs(bpm7 - bpm14) / asymptote : 0;
    var condA = growthRatio < THRESHOLDS.GROWTH_RATIO_7D;

    // === 条件 B：直近14日 wobble_ms 平均 ≧ 30日平均 ===
    var w14 = logs14.map(function (e) { return e.wobble_mean_ms; }).filter(isFinite);
    var w30 = logs30.map(function (e) { return e.wobble_mean_ms; }).filter(isFinite);
    var wobble14 = avg(w14);
    var wobble30 = avg(w30);
    // wobble は「小さいほど良い」→「14日平均が30日平均以上」=「最近のほうが揺らいでる」=悪化
    var condB = (w14.length >= 3 && w30.length >= 3) ? (wobble14 >= wobble30 * THRESHOLDS.WOBBLE_RATIO_14D_30D) : false;

    // === 条件 C：連続練習日数（コミット率）が閾値以下 ===
    var practiceDays14 = uniquePracticeDays(logs14);
    var condC = practiceDays14 <= THRESHOLDS.PRACTICE_DAYS_14D;

    var allTrue = condA && condB && condC;

    var metrics = {
      bpm7: bpm7, bpm14: bpm14, growthRatio: growthRatio,
      wobble14: wobble14, wobble30: wobble30,
      practiceDays14: practiceDays14,
      logs7: logs7.length, logs14: logs14.length, logs30: logs30.length,
      asymptote: asymptote
    };

    if (allTrue) {
      // 停滞タイプ判定（A/B/C どこが特に深刻か → 処方選択）
      var stagnationType = classifyStagnationType(metrics, condA, condB, condC);
      var prescription = getPrescription(stagnationType);
      var ctx = {
        bpm: bpm7,
        ms: wobble14,
        prev: wobble30,
        pattern: dominantPattern(logs14),
        days: 14,
        asymptote: asymptote,
        halfTimeDays: fit.halfTimeDays,
        stagnationType: stagnationType
      };

      // B12 連携：onStagnationDetected 起動信号発火
      fireStagnationSignal(ctx, prescription);

      // cooldown 開始＆評価時刻更新
      lsSet(LS_KEYS.LAST_FIRE_AT, nowMs());
      lsSet(LS_KEYS.LAST_EVAL_AT, nowMs());
      // fit 結果キャッシュ
      lsSet(LS_KEYS.FIT_CACHE, { fit: fit, at: nowMs(), version: V });

      return {
        status: 'fired',
        conditions: { A: condA, B: condB, C: condC },
        metrics: metrics,
        fit: fit,
        prescription: prescription,
        ctx: ctx,
        version: V
      };
    }

    // 不発：評価時刻だけ更新
    lsSet(LS_KEYS.LAST_EVAL_AT, nowMs());
    lsSet(LS_KEYS.FIT_CACHE, { fit: fit, at: nowMs(), version: V });

    return {
      status: 'no_fire',
      conditions: { A: condA, B: condB, C: condC },
      metrics: metrics,
      fit: fit,
      version: V
    };
  }

  function dominantPattern(logs) {
    var count = {};
    for (var i = 0; i < logs.length; i++) {
      var p = logs[i].pattern_id;
      if (!p) continue;
      count[p] = (count[p] || 0) + 1;
    }
    var best = null, bestN = 0;
    Object.keys(count).forEach(function (k) {
      if (count[k] > bestN) { bestN = count[k]; best = k; }
    });
    return best;
  }

  function classifyStagnationType(m, cA, cB, cC) {
    // 一番乖離が大きい条件を主因とする
    // 正規化スコア（0〜1, 大きいほど深刻）
    var scoreA = m.growthRatio === 0 ? 1 : (1 - Math.min(m.growthRatio / THRESHOLDS.GROWTH_RATIO_7D, 1));
    var scoreB = m.wobble30 > 0 ? Math.min((m.wobble14 / m.wobble30 - 1) + 0.5, 1) : 0.5;
    var scoreC = 1 - (m.practiceDays14 / 14);
    // 最大スコアの条件をタイプ確定
    if (scoreA >= scoreB && scoreA >= scoreC) return 'plateau';        // 伸びてない（A 主因）
    if (scoreB >= scoreA && scoreB >= scoreC) return 'precision_drop'; // 精度悪化（B 主因）
    return 'low_commitment';                                            // 練習不足（C 主因）
  }

  // -------------------------------------------------------------
  // 4. SDT (Self-Determination Theory) 3軸処方
  //    Autonomy（選ばせる）/ Competence（できた感）/ Relatedness（つながり）
  //    各 stagnationType ごとに 3軸の文言を返す
  // -------------------------------------------------------------
  var SDT_PRESCRIPTIONS = {
    plateau: {
      // 伸び率低下：autonomy 強めで「選び直し」を提示
      autonomy: {
        title: '次の一手は自分で選ぶ',
        message: '同じ BPM が続いている。今日は3つの中から自分で選んでみる：',
        options: [
          { id: 'cp_down', label: 'Challenge Point 微下げ（BPM -5%）' },
          { id: 'spacing_off', label: '48h Spacing OFF（連日 OK モード）' },
          { id: 'random_three', label: 'Random 異種3つ（普段やらないパターン）' }
        ]
      },
      competence: {
        title: '土台はできてる',
        message: '14日の記録が積み上がっている時点で、続ける筋肉は付いている。次の山に手をかけるだけ。',
        evidence_keys: ['practiceDays14', 'asymptote']
      },
      relatedness: {
        title: '同じ場所で止まる人は多い',
        message: 'プラトーは技術獲得曲線の正常段階。Mitscherlich 曲線で言えば asymptote の手前 80% 付近で誰もが減速する。',
        reference: 'Mitscherlich growth curve / Fitts & Posner skill stage 3'
      }
    },
    precision_drop: {
      // wobble 悪化：competence 強めで「精度自体は技術として戻せる」
      autonomy: {
        title: '揺らぎを削るルートを選ぶ',
        message: 'wobble が直近2週で増えた。3つから選ぶ：',
        options: [
          { id: 'metronome_focus', label: 'メトロノーム集中（BPM 据え置き・10分1セット）' },
          { id: 'subdivision_change', label: 'サブディビジョン切替（8分↔16分）' },
          { id: 'rest_24h', label: '24時間休む（過練習リセット）' }
        ]
      },
      competence: {
        title: '揺らぎは戻せる種類のズレ',
        message: '一度出せた精度は神経回路に残っている。再現性は休息と意識の置き方で戻る。',
        evidence_keys: ['wobble14', 'wobble30']
      },
      relatedness: {
        title: 'プロでも揺らぎは波打つ',
        message: 'ヴィニー・カリウタやベニー・グレブのインタビューでも「精度の悪い日」は明示されている。線形に伸びる前提を捨てる。',
        reference: 'Deliberate Practice (Ericsson) / motor learning variability literature'
      }
    },
    low_commitment: {
      // 練習日数不足：relatedness 強めで「無理させない・繋ぎ直す」
      autonomy: {
        title: '今日の量は自分で決める',
        message: '直近14日中の練習日が半分以下。3つから選ぶ：',
        options: [
          { id: 'micro_5min', label: '5分だけやる（座るだけでもOK）' },
          { id: 'pattern_pick_one', label: '1パターンだけ叩く（選ばせる）' },
          { id: 'today_off', label: '今日は OFF（記録だけ残す）' }
        ]
      },
      competence: {
        title: '0 にしないことが土台',
        message: '量より「ゼロ日連続を切らないこと」が再開コストを下げる。5分でも記録は積み上がる。',
        evidence_keys: ['practiceDays14']
      },
      relatedness: {
        title: 'バンドの仲間は今日も叩いている',
        message: '妖怪のメンバー・ライブハウスの担当者・対バン相手も同じ時間軸で動いている。完全に切らない選択肢が一番強い。',
        reference: 'Self-Determination Theory (Deci & Ryan) - Relatedness need'
      }
    }
  };

  /**
   * stagnationType: 'plateau' | 'precision_drop' | 'low_commitment'
   * 戻り値: { type, autonomy:{...}, competence:{...}, relatedness:{...} }
   */
  function getPrescription(stagnationType) {
    var t = stagnationType;
    if (!SDT_PRESCRIPTIONS[t]) t = 'plateau';
    var p = SDT_PRESCRIPTIONS[t];
    return {
      type: t,
      autonomy: p.autonomy,
      competence: p.competence,
      relatedness: p.relatedness,
      sdt_axes_used: ['autonomy', 'competence', 'relatedness'],
      version: V
    };
  }

  // -------------------------------------------------------------
  // 5. B12 連携：D3 助言エンジン起動信号
  //    - window.SteadyCore_B12 が公開する onStagnationDetected があれば呼ぶ
  //    - なければ debug log のみ（B12 未実装時の fallback）
  //    - CustomEvent も発火（疎結合 listener 用）
  // -------------------------------------------------------------
  function fireStagnationSignal(ctx, prescription) {
    try {
      var b12 = global.SteadyCore_B12 || global.SteadyB12;
      if (b12 && typeof b12.onStagnationDetected === 'function') {
        try { b12.onStagnationDetected(ctx, prescription); }
        catch (e) { if (global.STEADY_DEBUG) console.warn('[B13] B12 onStagnationDetected threw:', e); }
      } else {
        if (global.STEADY_DEBUG) console.warn('[B13] B12 onStagnationDetected unavailable - prescription will display via fallback path. ctx=', ctx);
      }
      // 疎結合 listener 用 CustomEvent
      if (global.dispatchEvent && typeof global.CustomEvent === 'function') {
        global.dispatchEvent(new global.CustomEvent('steady:stagnation:fired', {
          detail: { ctx: ctx, prescription: prescription, at: nowMs() }
        }));
      }
    } catch (_) { /* noop */ }
  }

  // -------------------------------------------------------------
  // 6. 24h 1回タイマー（起動時チェック方式・PWA backgound 不安定対策）
  // -------------------------------------------------------------
  function shouldRunDailyEval() {
    var last = lsGet(LS_KEYS.LAST_EVAL_AT, 0);
    if (!last) return true;
    return (nowMs() - last) >= dayMs();
  }

  function scheduleNextEvaluation() {
    if (!shouldRunDailyEval()) return null;
    try {
      return evaluate();
    } catch (e) {
      if (global.STEADY_DEBUG) console.warn('[B13] scheduleNextEvaluation failed:', e);
      return null;
    }
  }

  // -------------------------------------------------------------
  // 7. ユーザー処方選択の記録
  // -------------------------------------------------------------
  function recordUserDecision(stagnationType, optionId) {
    var arr = lsGet(LS_KEYS.DECISIONS, []);
    if (!Array.isArray(arr)) arr = [];
    arr.push({
      ts: nowMs(),
      stagnationType: stagnationType,
      optionId: optionId,
      version: V
    });
    // 直近 90 日分のみ保持
    var cutoff = nowMs() - 90 * dayMs();
    arr = arr.filter(function (e) { return e.ts >= cutoff; });
    lsSet(LS_KEYS.DECISIONS, arr);
    return arr.length;
  }

  // -------------------------------------------------------------
  // 8. デバッグ用：状態読み出し（AL011 監査用）
  // -------------------------------------------------------------
  function debugState() {
    return {
      version: V,
      lastEvalAt: lsGet(LS_KEYS.LAST_EVAL_AT, null),
      lastFireAt: lsGet(LS_KEYS.LAST_FIRE_AT, null),
      decisions: lsGet(LS_KEYS.DECISIONS, []),
      fitCache: lsGet(LS_KEYS.FIT_CACHE, null),
      thresholds: THRESHOLDS,
      ls_keys: LS_KEYS
    };
  }

  function resetForTesting() {
    // 開発用・本番 UI からは呼ばない
    [LS_KEYS.LAST_EVAL_AT, LS_KEYS.LAST_FIRE_AT, LS_KEYS.FIT_CACHE].forEach(function (k) {
      try { localStorage.removeItem(k); } catch (_) {}
    });
  }

  // -------------------------------------------------------------
  // 9. 公開 API
  // -------------------------------------------------------------
  // 発注タスク仕様の公開シェイプ
  global.SteadyStagnation = {
    evaluate: evaluate,
    getPrescription: getPrescription,
    fitCurve: fitCurve,
    // 補助 API（仕様外だが運用上必要・監査用）
    scheduleNextEvaluation: scheduleNextEvaluation,
    recordUserDecision: recordUserDecision,
    debugState: debugState,
    resetForTesting: resetForTesting,
    THRESHOLDS: THRESHOLDS,
    LS_KEYS: LS_KEYS,
    version: V
  };

  // spec JSON 互換 alias（B12 連携・既存 IIFE モジュールパターン）
  global.SteadyCore_B13 = {
    evaluateStagnation: evaluate,
    scheduleNextEvaluation: scheduleNextEvaluation,
    fitCurve: fitCurve,
    getPrescription: getPrescription,
    version: V
  };

  // 自動評価：DOMContentLoaded 後に1回だけ起動チェック
  // （B12 がまだロードされていない可能性があるため少し遅延 = 1500ms）
  function autoBoot() {
    setTimeout(function () {
      try {
        // データ未蓄積段階での noisy console を抑制
        var logs = lsGet(LS_KEYS.BPM_LOG, []);
        if (!Array.isArray(logs) || logs.length < THRESHOLDS.MIN_LOG_DAYS) return;
        scheduleNextEvaluation();
      } catch (_) { /* noop */ }
    }, 1500);
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoBoot);
    } else {
      autoBoot();
    }
  }

})(typeof window !== 'undefined' ? window : this);
