/* =============================================================
   STEADY v3.2.0r2 — steady-recorder.js
   B10（録音）+ B11（解析）統合 module（AL007 #4号 並列実装）

   目的：Q7 録音習慣 D（最大穴・本丸対象）に対応する
        「録音 → 翌日聴くループ」最小スタック。

   設計原則（並列衝突回避）：
   - 既存 steady-shared.js / steady.html / steady-core.html を改変しない
   - 単一 IIFE で window.SteadyRecorder のみ公開
   - localStorage キーは _v3_2 名前空間に全準拠（衝突防止）
   - IndexedDB は 仕様書通り steady_recordings_v3_2 / blobs

   公開 API（命令書通り）：
     window.SteadyRecorder = {
       startRec(opts),       // {bpm, pattern_id, memo} を渡して録音開始
       stopRec(),            // 録音停止 → Blob 保存 → 自動解析（解析結果 Promise を返す）
       listRecordings(),     // IDB の録音メタ一覧（昇順 createdAt）
       analyze(recordingId), // 既存録音を再解析（オンセット + wobble_ms 履歴 dataset）
       getReminderToday(),   // 「翌日聴くリマインダー」発火条件判定
       // 補助
       deleteRecording(id),
       configure(opts),      // threshold/ratio/min_gap_ms 等の調整
       getState()
     };
   ============================================================= */

(function (global) {
  'use strict';

  // -------------------------------------------------------------
  // 0. 衝突回避：既存 SteadyRecorder があれば上書きしない（並列実装ガード）
  // -------------------------------------------------------------
  if (global.SteadyRecorder && global.SteadyRecorder.__version) {
    if (global.STEADY_DEBUG) console.warn('[steady-recorder] already loaded:', global.SteadyRecorder.__version);
    return;
  }

  // -------------------------------------------------------------
  // 1. 定数（仕様書 shared_design_decisions 準拠）
  // -------------------------------------------------------------
  var IDB_DB_NAME = 'steady_recordings_v3_2';
  var IDB_VERSION = 1;
  var IDB_STORE = 'blobs';

  // localStorage キー（仕様書 B10 localStorage_keys / B11 wobble_api_integration）
  var LS_KEYS = {
    REC_SESSION: 'steady_record_session_v3_2',
    REC_LAST_UPLOAD: 'steady_record_lastUploadedAt_v3_2',
    REC_PERMISSIONS: 'steady_record_permissions_v3_2',
    WOBBLE_LOG: 'steady_wobble_log_v3_2',
    BPM_LOG: 'steady_bpm_log_v3_2',
    REMINDER_LAST_SHOWN: 'steady_recorder_reminder_lastShownAt_v3_2',
    REMINDER_LAST_REC_ID: 'steady_recorder_reminder_lastRecordingId_v3_2'
  };

  // 解析チューナブル（仕様書 B11 tunable_params_for_AL011_audit 準拠）
  var ANALYSIS_DEFAULTS = {
    hop_ms: 10,                  // RMS hop（仕様書 envelope_hop_ms）
    threshold: 0.6,              // local max ratio
    ratio: 1.5,                  // 前 frame 比増加率
    min_gap_ms: 50,              // 連続 onset 抑制（人間が叩ける最短間隔）
    subdivision: 16,             // 16 分音符グリッド
    target_sample_rate: 48000,
    max_filesize_mb: 50,
    duration_max_seconds: 300,
    wobble_log_retention_days: 90 // 仕様書 log_retention_days
  };

  // 解析設定（configure() で上書き可能）
  var analysisCfg = Object.assign({}, ANALYSIS_DEFAULTS);

  // localStorage 安全ラッパ（steady-shared.js があればそちらを優先）
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
  // 2. 内部状態
  // -------------------------------------------------------------
  var state = {
    recState: 'idle', // idle | requesting_permission | recording | stopping | error
    mediaStream: null,
    mediaRecorder: null,
    chunks: [],
    startedAt: null,
    bpm: null,
    pattern_id: null,
    memo: null,
    mimeType: null,
    timerHandle: null,
    onTick: null,
    db: null,
    dbOpenPromise: null,
    lastError: null
  };

  // -------------------------------------------------------------
  // 3. IndexedDB ヘルパ（仕様書 indexeddb_schema 準拠）
  // -------------------------------------------------------------
  function openDB() {
    if (state.db) return Promise.resolve(state.db);
    if (state.dbOpenPromise) return state.dbOpenPromise;
    state.dbOpenPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      var req = global.indexedDB.open(IDB_DB_NAME, IDB_VERSION);
      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          var store = db.createObjectStore(IDB_STORE);
          // index: createdAt（仕様書 indexes.createdAt）
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = function (ev) {
        state.db = ev.target.result;
        // バージョン変更で他タブが開けない事故防止
        state.db.onversionchange = function () {
          try { state.db.close(); state.db = null; } catch (_) {}
        };
        resolve(state.db);
      };
      req.onerror = function (ev) {
        state.dbOpenPromise = null;
        reject(ev.target.error || new Error('IDB open failed'));
      };
      req.onblocked = function () {
        state.dbOpenPromise = null;
        reject(new Error('IDB open blocked'));
      };
    });
    return state.dbOpenPromise;
  }

  function idbPut(key, value) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        var store = tx.objectStore(IDB_STORE);
        var req = store.put(value, key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
        tx.onabort = function () { reject(tx.error || new Error('tx aborted')); };
      });
    });
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbDelete(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        var req = tx.objectStore(IDB_STORE).delete(key);
        req.onsuccess = function () { resolve(true); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbListAll() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var store = tx.objectStore(IDB_STORE);
        var results = [];
        // index 経由で createdAt 昇順取得
        var idx;
        try { idx = store.index('createdAt'); } catch (_) { idx = null; }
        var req = idx ? idx.openCursor() : store.openCursor();
        req.onsuccess = function (ev) {
          var cursor = ev.target.result;
          if (cursor) {
            // メタのみ返す（Blob 本体は重いので除外）
            var v = cursor.value || {};
            results.push({
              id: cursor.primaryKey,
              createdAt: v.createdAt || null,
              mime: v.mime || null,
              duration_sec: v.duration_sec || null,
              pattern_id: v.pattern_id || null,
              bpm: v.bpm || null,
              memo: v.memo || null,
              analyzed: !!v.analyzed,
              wobble_summary: v.wobble_summary || null
            });
            cursor.continue();
          } else {
            resolve(results);
          }
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // 容量チェック（仕様書 quota_check）
  function ensureQuota() {
    if (!global.navigator || !global.navigator.storage || !global.navigator.storage.estimate) {
      return Promise.resolve({ ok: true, reason: 'estimate-api-unavailable' });
    }
    return global.navigator.storage.estimate().then(function (e) {
      var usage = e.usage || 0;
      var quota = e.quota || 0;
      if (quota > 0 && usage > quota * 0.9) {
        // 古い録音を最大 3 件削除して再試行
        return idbListAll().then(function (list) {
          var toDelete = list.slice(0, Math.min(3, list.length));
          return Promise.all(toDelete.map(function (m) { return idbDelete(m.id); })).then(function () {
            return { ok: true, reason: 'pruned-' + toDelete.length };
          });
        }).catch(function () {
          return { ok: false, reason: 'quota-exceeded-prune-failed' };
        });
      }
      return { ok: true, reason: 'within-quota' };
    }).catch(function () { return { ok: true, reason: 'estimate-error' }; });
  }

  // -------------------------------------------------------------
  // 4. MediaRecorder MIME ピック（仕様書 MediaRecorder_mime_priority 準拠）
  // -------------------------------------------------------------
  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return null;
    var candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',                  // iOS Safari 14.5+
      'audio/ogg;codecs=opus'
    ];
    for (var i = 0; i < candidates.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) {
          return candidates[i];
        }
      } catch (_) {}
    }
    return null;
  }

  // -------------------------------------------------------------
  // 5. B10：録音開始
  //    仕様書 startRecording() 準拠（getUserMedia 制約は AGC/NS/EC OFF）
  // -------------------------------------------------------------
  function startRec(opts) {
    opts = opts || {};
    if (state.recState === 'recording' || state.recState === 'requesting_permission') {
      return Promise.reject(new Error('already recording (state=' + state.recState + ')'));
    }
    if (!global.navigator || !global.navigator.mediaDevices || !global.navigator.mediaDevices.getUserMedia) {
      state.recState = 'error';
      state.lastError = 'getUserMedia unavailable';
      return Promise.reject(new Error('getUserMedia unavailable'));
    }
    var mime = pickMimeType();
    if (!mime) {
      state.recState = 'error';
      state.lastError = 'no supported MediaRecorder MIME';
      return Promise.reject(new Error('MediaRecorder not supported on this browser'));
    }

    state.recState = 'requesting_permission';
    state.lastError = null;
    state.bpm = (typeof opts.bpm === 'number') ? opts.bpm : null;
    state.pattern_id = opts.pattern_id || null;
    state.memo = opts.memo || null;
    state.mimeType = mime;

    var constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: analysisCfg.target_sample_rate
      }
    };

    return global.navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      state.mediaStream = stream;
      lsSet(LS_KEYS.REC_PERMISSIONS, 'granted');

      var rec = new MediaRecorder(stream, { mimeType: mime });
      state.mediaRecorder = rec;
      state.chunks = [];
      state.startedAt = Date.now();

      rec.ondataavailable = function (ev) {
        if (ev.data && ev.data.size > 0) {
          state.chunks.push(ev.data);
        }
      };

      // 仕様書 ios_quirks：start(timeslice) を呼ばず start() のみ。stop() で 1 回 ondataavailable を取る
      rec.start();
      state.recState = 'recording';

      // セッション ID を LS に書く（再起動検出用）
      lsSet(LS_KEYS.REC_SESSION, {
        id: state.startedAt,
        bpm: state.bpm,
        pattern_id: state.pattern_id,
        startedAt: state.startedAt
      });

      // タイマー（呼び出し側が表示する用フック）
      if (state.timerHandle) { clearInterval(state.timerHandle); }
      state.timerHandle = setInterval(function () {
        if (typeof state.onTick === 'function') {
          try { state.onTick(Date.now() - state.startedAt); } catch (_) {}
        }
        // 上限超過なら自動停止
        if (Date.now() - state.startedAt > analysisCfg.duration_max_seconds * 1000) {
          stopRec().catch(function () {});
        }
      }, 250);

      return { ok: true, sessionId: state.startedAt, mime: mime };
    }).catch(function (err) {
      state.recState = 'error';
      state.lastError = err && err.message || String(err);
      var name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        lsSet(LS_KEYS.REC_PERMISSIONS, 'denied');
      }
      throw err;
    });
  }

  // -------------------------------------------------------------
  // 6. B10：録音停止 → IDB 保存 → 自動解析
  //    仕様書 stopRecording() 準拠
  // -------------------------------------------------------------
  function stopRec() {
    if (state.recState !== 'recording') {
      return Promise.reject(new Error('not recording (state=' + state.recState + ')'));
    }
    var rec = state.mediaRecorder;
    if (!rec) return Promise.reject(new Error('no MediaRecorder'));

    state.recState = 'stopping';
    if (state.timerHandle) {
      clearInterval(state.timerHandle);
      state.timerHandle = null;
    }

    return new Promise(function (resolve, reject) {
      // stop の dataavailable を待つ
      var done = false;
      var timeout = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('stop timeout (no dataavailable within 5s)'));
      }, 5000);

      rec.onstop = function () {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        try {
          var stoppedAt = Date.now();
          var durationMs = stoppedAt - state.startedAt;
          var blob = state.chunks.length === 1
            ? state.chunks[0]
            : new Blob(state.chunks, { type: state.mimeType });

          // ストリーム解放
          if (state.mediaStream) {
            try {
              state.mediaStream.getTracks().forEach(function (t) { t.stop(); });
            } catch (_) {}
            state.mediaStream = null;
          }

          // 容量チェック → IDB put
          var key = state.startedAt; // out-of-line key = timestamp_ms（仕様書通り）
          var record = {
            blob: blob,
            createdAt: key,
            mime: state.mimeType,
            duration_sec: durationMs / 1000,
            pattern_id: state.pattern_id,
            bpm: state.bpm,
            memo: state.memo,
            analyzed: false,
            wobble_summary: null
          };

          ensureQuota().then(function () {
            return idbPut(key, record);
          }).then(function () {
            state.recState = 'idle';
            state.mediaRecorder = null;
            state.chunks = [];
            // セッション LS をクリア
            lsSet(LS_KEYS.REC_SESSION, null);
            // 自動解析（B11）
            return analyze(key, {
              pattern_id: state.pattern_id,
              bpm: state.bpm,
              subdivision: analysisCfg.subdivision
            }).then(function (analysis) {
              return {
                ok: true,
                idbKey: key,
                duration_sec: durationMs / 1000,
                analysis: analysis
              };
            }).catch(function (analyzeErr) {
              // 解析失敗でも録音は保存済み（fallback：手動入力 UI を出す前提）
              return {
                ok: true,
                idbKey: key,
                duration_sec: durationMs / 1000,
                analysis: null,
                analyzeError: analyzeErr && analyzeErr.message || String(analyzeErr)
              };
            });
          }).then(resolve).catch(function (err) {
            state.recState = 'error';
            state.lastError = err && err.message || String(err);
            reject(err);
          });
        } catch (e) {
          state.recState = 'error';
          state.lastError = e && e.message || String(e);
          reject(e);
        }
      };

      rec.onerror = function (ev) {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        var err = ev && ev.error || new Error('MediaRecorder error');
        state.recState = 'error';
        state.lastError = err.message || String(err);
        reject(err);
      };

      try {
        rec.stop();
      } catch (e) {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        state.recState = 'error';
        state.lastError = e && e.message || String(e);
        reject(e);
      }
    });
  }

  // -------------------------------------------------------------
  // 7. B10：録音一覧
  // -------------------------------------------------------------
  function listRecordings() {
    return idbListAll();
  }

  // -------------------------------------------------------------
  // 8. B11：解析（オンセット検出 + wobble_ms 計算）
  //    仕様書 algorithm_pseudocode 完全準拠
  // -------------------------------------------------------------
  function analyze(recordingId, opts) {
    opts = opts || {};
    var t0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
    return idbGet(recordingId).then(function (rec) {
      if (!rec) throw new Error('recording not found: ' + recordingId);
      var blob = rec.blob;
      if (!blob) throw new Error('blob missing');

      var bpm = (typeof opts.bpm === 'number') ? opts.bpm : rec.bpm;
      var pattern_id = opts.pattern_id || rec.pattern_id;
      var subdivision = opts.subdivision || analysisCfg.subdivision;
      if (!bpm || bpm <= 0) {
        throw new Error('BPM unknown — cannot build target grid');
      }

      return blob.arrayBuffer().then(function (arrBuf) {
        return decodeAudio(arrBuf).then(function (audioBuffer) {
          var sampleRate = audioBuffer.sampleRate;
          var data = mergeChannelsMono(audioBuffer);
          var hopSamples = Math.max(1, Math.round(sampleRate * (analysisCfg.hop_ms / 1000)));
          var envelope = computeRMSEnvelope(data, hopSamples);
          var onsetIdxs = detectOnsets(envelope, analysisCfg.threshold, analysisCfg.ratio, analysisCfg.min_gap_ms, analysisCfg.hop_ms);
          var onsetTimesMs = onsetIdxs.map(function (i) { return i * analysisCfg.hop_ms; });

          var durationSec = audioBuffer.duration;
          var beatIntervalMs = 60000 / bpm;
          var gridIntervalMs = beatIntervalMs / (subdivision / 4);
          var gridLen = Math.ceil((durationSec * 1000) / gridIntervalMs) + 1;

          var wobbleMs = onsetTimesMs.map(function (t) {
            // O(1) nearest grid point
            var nearestIdx = Math.round(t / gridIntervalMs);
            if (nearestIdx < 0) nearestIdx = 0;
            if (nearestIdx > gridLen) nearestIdx = gridLen;
            var nearestT = nearestIdx * gridIntervalMs;
            return t - nearestT;
          });

          var meanMs = 0, sdMs = 0;
          if (wobbleMs.length > 0) {
            var absSum = 0;
            for (var i = 0; i < wobbleMs.length; i++) absSum += Math.abs(wobbleMs[i]);
            meanMs = absSum / wobbleMs.length;
            // SD（符号付きの標準偏差）
            var rawMean = 0;
            for (var j = 0; j < wobbleMs.length; j++) rawMean += wobbleMs[j];
            rawMean = rawMean / wobbleMs.length;
            var variance = 0;
            for (var k = 0; k < wobbleMs.length; k++) {
              var d = wobbleMs[k] - rawMean;
              variance += d * d;
            }
            sdMs = Math.sqrt(variance / wobbleMs.length);
          }

          var t1 = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
          var elapsedMs = t1 - t0;

          var summary = {
            mean_ms: round1(meanMs),
            sd_ms: round1(sdMs),
            count: wobbleMs.length
          };

          // 解析結果を IDB レコードに反映
          rec.analyzed = true;
          rec.wobble_summary = summary;

          return idbPut(recordingId, rec).then(function () {
            // wobble log（B13 が参照）に append
            appendWobbleLog({
              ts: Date.now(),
              pattern_id: pattern_id,
              bpm: bpm,
              mean_ms: summary.mean_ms,
              sd_ms: summary.sd_ms,
              count: summary.count,
              source: 'recording'
            });
            // bpm log（B13 用・wobble と並列）
            appendBpmLog({
              ts: Date.now(),
              pattern_id: pattern_id,
              bpm: bpm,
              wobble_mean_ms: summary.mean_ms,
              wobble_sd_ms: summary.sd_ms,
              source: 'recording'
            });
            // 翌日リマインダー用：最終解析 ID を記録
            lsSet(LS_KEYS.REC_LAST_UPLOAD, Date.now());
            lsSet(LS_KEYS.REMINDER_LAST_REC_ID, recordingId);

            // v3.3.0r3 #7：3h 後の遅延 FB を予約 ＋ 14 件超過分を prune
            try { scheduleDelayedFeedback(recordingId, summary); } catch (_) {}
            try { pruneOldRecordings(); } catch (_) {}

            return {
              recordingId: recordingId,
              onset_count: wobbleMs.length,
              wobble_mean_ms: summary.mean_ms,
              wobble_sd_ms: summary.sd_ms,
              wobble_array: wobbleMs.map(round1),
              onset_times_ms: onsetTimesMs.map(round1),
              bpm: bpm,
              subdivision: subdivision,
              duration_sec: round1(durationSec),
              elapsed_ms: round1(elapsedMs),
              dataset_for_chart: buildChartDataset(wobbleMs, onsetTimesMs),
              // v3.3.0r3 #7：即時 FB は binary signal のみ
              immediate_signal: getImmediateBinarySignal(summary)
            };
          });
        });
      });
    });
  }

  function round1(n) {
    if (typeof n !== 'number' || !isFinite(n)) return 0;
    return Math.round(n * 10) / 10;
  }

  // チャート用 dataset（仕様書 wobble_ms 履歴グラフ用）
  function buildChartDataset(wobbleMs, onsetTimesMs) {
    var pts = [];
    for (var i = 0; i < wobbleMs.length; i++) {
      pts.push({ x: round1(onsetTimesMs[i]), y: round1(wobbleMs[i]) });
    }
    return {
      points: pts,
      x_label: 'time (ms)',
      y_label: 'wobble (ms)',
      sample_count: wobbleMs.length
    };
  }

  // モノラル化（複数 ch なら平均）
  function mergeChannelsMono(audioBuffer) {
    var ch = audioBuffer.numberOfChannels;
    var len = audioBuffer.length;
    if (ch === 1) return audioBuffer.getChannelData(0);
    var out = new Float32Array(len);
    for (var c = 0; c < ch; c++) {
      var src = audioBuffer.getChannelData(c);
      for (var i = 0; i < len; i++) out[i] += src[i];
    }
    for (var j = 0; j < len; j++) out[j] = out[j] / ch;
    return out;
  }

  // RMS エンベロープ（仕様書 computeRMSEnvelope）
  function computeRMSEnvelope(data, hopSamples) {
    var n = data.length;
    var frames = Math.ceil(n / hopSamples);
    var out = new Float32Array(frames);
    for (var f = 0; f < frames; f++) {
      var start = f * hopSamples;
      var end = Math.min(start + hopSamples, n);
      var sum = 0;
      var count = end - start;
      if (count <= 0) { out[f] = 0; continue; }
      for (var i = start; i < end; i++) {
        sum += data[i] * data[i];
      }
      out[f] = Math.sqrt(sum / count);
    }
    return out;
  }

  // オンセット検出（仕様書 detectOnsets：env[i] > env[i-1]*ratio かつ env[i] > localMax*threshold）
  function detectOnsets(envelope, threshold, ratio, minGapMs, hopMs) {
    var minGapFrames = Math.max(1, Math.round(minGapMs / hopMs));
    // local max（全体の最大値ベース・簡易版）
    var globalMax = 0;
    for (var i = 0; i < envelope.length; i++) {
      if (envelope[i] > globalMax) globalMax = envelope[i];
    }
    if (globalMax <= 0) return [];
    var absThreshold = globalMax * threshold;

    var onsets = [];
    var lastOnsetFrame = -minGapFrames; // 最初のオンセットを許可
    for (var k = 1; k < envelope.length; k++) {
      var prev = envelope[k - 1];
      var cur = envelope[k];
      var rising = (prev > 0)
        ? (cur > prev * ratio)
        : (cur > 0); // 無音 → 音への立ち上がり
      var loud = cur > absThreshold;
      if (rising && loud && (k - lastOnsetFrame) >= minGapFrames) {
        onsets.push(k);
        lastOnsetFrame = k;
      }
    }
    return onsets;
  }

  // decodeAudioData：OfflineAudioContext で実施（仕様書 algorithm_pseudocode step 2-3）
  function decodeAudio(arrayBuffer) {
    return new Promise(function (resolve, reject) {
      // OfflineAudioContext / AudioContext のいずれかで decode 可能
      var Ctor = global.OfflineAudioContext || global.webkitOfflineAudioContext;
      var ctx;
      try {
        if (Ctor) {
          // 仮 length=1（decode 用なので不問）
          ctx = new Ctor({ numberOfChannels: 1, length: 1, sampleRate: analysisCfg.target_sample_rate });
        } else {
          var ACtor = global.AudioContext || global.webkitAudioContext;
          if (!ACtor) {
            reject(new Error('No AudioContext available'));
            return;
          }
          ctx = new ACtor();
        }
      } catch (e) {
        // OfflineAudioContext が constructor 形式に対応してないブラウザ
        try {
          var ACtor2 = global.AudioContext || global.webkitAudioContext;
          ctx = new ACtor2();
        } catch (e2) {
          reject(e2);
          return;
        }
      }

      // decodeAudioData は 2 形式：Promise / callback
      try {
        var p = ctx.decodeAudioData(arrayBuffer);
        if (p && typeof p.then === 'function') {
          p.then(resolve).catch(reject);
        } else {
          // callback 形式（Safari 旧）
          ctx.decodeAudioData(arrayBuffer, resolve, reject);
        }
      } catch (e) {
        reject(e);
      }
    });
  }

  // -------------------------------------------------------------
  // 9. wobble log / bpm log（仕様書 wobble_api_integration / B13 連携）
  // -------------------------------------------------------------
  function appendWobbleLog(entry) {
    var log = lsGet(LS_KEYS.WOBBLE_LOG, []) || [];
    if (!Array.isArray(log)) log = [];
    log.push(entry);
    // 90 日分のみ保持
    var cutoff = Date.now() - analysisCfg.wobble_log_retention_days * 24 * 60 * 60 * 1000;
    log = log.filter(function (e) { return e && typeof e.ts === 'number' && e.ts >= cutoff; });
    lsSet(LS_KEYS.WOBBLE_LOG, log);
  }

  function appendBpmLog(entry) {
    var log = lsGet(LS_KEYS.BPM_LOG, []) || [];
    if (!Array.isArray(log)) log = [];
    log.push(entry);
    var cutoff = Date.now() - analysisCfg.wobble_log_retention_days * 24 * 60 * 60 * 1000;
    log = log.filter(function (e) { return e && typeof e.ts === 'number' && e.ts >= cutoff; });
    lsSet(LS_KEYS.BPM_LOG, log);
  }

  // -------------------------------------------------------------
  // 10. 翌日リマインダー（命令書 B11「翌日聴くリマインダー」）
  //     - 直近の録音から 18-48h 経過していて、まだ「翌日聴いた」操作がない場合に true
  //     - LS に「最終表示日」を保持して 1 日 1 回まで
  // -------------------------------------------------------------
  function getReminderToday() {
    var lastUpload = lsGet(LS_KEYS.REC_LAST_UPLOAD, null);
    var lastShown = lsGet(LS_KEYS.REMINDER_LAST_SHOWN, null);
    var lastRecId = lsGet(LS_KEYS.REMINDER_LAST_REC_ID, null);

    if (typeof lastUpload !== 'number') {
      return { show: false, reason: 'no-recording-yet', recordingId: null, hoursSinceUpload: null };
    }
    var now = Date.now();
    var hoursSince = (now - lastUpload) / (1000 * 60 * 60);

    // 18h 〜 48h ウィンドウ（翌日 = 大体 24h・幅を取る）
    if (hoursSince < 18) {
      return { show: false, reason: 'too-early', recordingId: lastRecId, hoursSinceUpload: round1(hoursSince) };
    }
    if (hoursSince > 48) {
      // 48h 過ぎた録音は「もう一度録ろう」促し
      return {
        show: true,
        reason: 'long-overdue',
        recordingId: lastRecId,
        hoursSinceUpload: round1(hoursSince),
        message_kind: 'rerecord_suggest'
      };
    }
    // 当日の表示済チェック
    if (typeof lastShown === 'number') {
      var todayStart = startOfTodayMs();
      if (lastShown >= todayStart) {
        return { show: false, reason: 'already-shown-today', recordingId: lastRecId, hoursSinceUpload: round1(hoursSince) };
      }
    }
    return {
      show: true,
      reason: 'next-day-window',
      recordingId: lastRecId,
      hoursSinceUpload: round1(hoursSince),
      message_kind: 'next_day_listen'
    };
  }

  function markReminderShownToday() {
    lsSet(LS_KEYS.REMINDER_LAST_SHOWN, Date.now());
  }

  function startOfTodayMs() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // -------------------------------------------------------------
  // v3.3.0r3 #7：遅延フィードバック（Metcalfe 2009 PMC3034228）
  //   - 録音直後の即時 FB は binary signals のみ（"on beat" / "behind" / "ahead"）
  //   - 詳細スコア表示は 3 時間後に「振り返り」通知 → reflection modal
  //   - 金曜 19:00 collage stitcher（Mon highlight + Wed + Fri 各 40-60s）
  //   - 録音は最大 14 件に prune（LS メタは getRecordingMetaList() で IDB 経由で参照）
  // -------------------------------------------------------------
  var DELAY_FEEDBACK_HOURS = 3;
  var DELAY_FEEDBACK_LS = 'steady_recorder_delayed_fb_v3_3';
  var COLLAGE_LAST_LS = 'steady_recorder_collage_last_v3_3';
  var MAX_RECORDINGS = 14;

  // 遅延 FB 即時 binary 評価（onset から平均 wobble_ms を ±15ms threshold で 3 値化）
  function getImmediateBinarySignal(wobbleSummary) {
    if (!wobbleSummary || typeof wobbleSummary.mean_ms !== 'number') {
      return { signal: 'unknown', label: '解析中…' };
    }
    var m = wobbleSummary.mean_ms;
    if (Math.abs(m) <= 15) return { signal: 'on_beat', label: 'クリックにぴたり' };
    if (m < -15) return { signal: 'ahead', label: '前ノリ気味（クリックより少し早い）' };
    return { signal: 'behind', label: '後ノリ気味（クリックより少し遅い）' };
  }

  // 録音完了時に呼ぶ：3h 後に振り返り通知の予約 LS 登録
  function scheduleDelayedFeedback(recordingId, wobbleSummary) {
    if (typeof recordingId !== 'number') return false;
    var queue = lsGet(DELAY_FEEDBACK_LS, []) || [];
    if (!Array.isArray(queue)) queue = [];
    queue.push({
      recordingId: recordingId,
      scheduledAt: Date.now() + DELAY_FEEDBACK_HOURS * 60 * 60 * 1000,
      createdAt: Date.now(),
      wobbleSummary: wobbleSummary || null,
      shown: false
    });
    // 古い shown 済を 30 件以上残さない
    queue = queue.slice(-30);
    lsSet(DELAY_FEEDBACK_LS, queue);
    return true;
  }

  // 起動時 / フォアグラウンド復帰時に呼ぶ：時間到達した遅延 FB を返す
  function getPendingDelayedFeedback() {
    var queue = lsGet(DELAY_FEEDBACK_LS, []) || [];
    if (!Array.isArray(queue) || queue.length === 0) return null;
    var now = Date.now();
    for (var i = 0; i < queue.length; i++) {
      var q = queue[i];
      if (!q || q.shown) continue;
      if (q.scheduledAt && q.scheduledAt <= now) {
        return q;
      }
    }
    return null;
  }

  function markDelayedFeedbackShown(recordingId) {
    var queue = lsGet(DELAY_FEEDBACK_LS, []) || [];
    if (!Array.isArray(queue)) return false;
    var found = false;
    for (var i = 0; i < queue.length; i++) {
      if (queue[i] && queue[i].recordingId === recordingId) {
        queue[i].shown = true;
        queue[i].shownAt = Date.now();
        found = true;
      }
    }
    lsSet(DELAY_FEEDBACK_LS, queue);
    return found;
  }

  // 録音 prune：最大 14 件・古い順に削除
  function pruneOldRecordings() {
    return idbListAll().then(function (list) {
      if (!list || list.length <= MAX_RECORDINGS) return { pruned: 0 };
      // createdAt 昇順で並んでいるので先頭が古い
      var toDelete = list.slice(0, list.length - MAX_RECORDINGS);
      return Promise.all(toDelete.map(function (m) { return idbDelete(m.id); })).then(function () {
        return { pruned: toDelete.length };
      });
    });
  }

  // 金曜 19:00 collage 判定（Mon highlight + Wed + Fri 各 40-60s を抽出）
  // 実装：collage 候補 ID 配列を返すだけ（再生 UI は呼び出し側）
  function getFridayCollageCandidates() {
    var now = new Date();
    // 金曜 = 5（日=0..土=6）／19:00 以降のみ発火
    if (now.getDay() !== 5 || now.getHours() < 19) {
      return Promise.resolve({ ready: false, reason: 'not-friday-evening', dayOfWeek: now.getDay(), hour: now.getHours() });
    }
    // 当週月曜 0:00 を起点
    var weekStart = new Date(now);
    var diffToMon = (weekStart.getDay() + 6) % 7; // 月=0
    weekStart.setDate(weekStart.getDate() - diffToMon);
    weekStart.setHours(0, 0, 0, 0);
    var weekStartMs = weekStart.getTime();
    // 既に今週分 collage 済ならスキップ
    var lastCollage = lsGet(COLLAGE_LAST_LS, null);
    if (typeof lastCollage === 'number' && lastCollage >= weekStartMs) {
      return Promise.resolve({ ready: false, reason: 'already-stitched-this-week' });
    }
    return idbListAll().then(function (list) {
      var inWeek = (list || []).filter(function (r) {
        return r.createdAt && r.createdAt >= weekStartMs && r.createdAt <= now.getTime();
      });
      if (inWeek.length === 0) {
        return { ready: false, reason: 'no-recordings-this-week' };
      }
      // 月/水/金のうち最も新しい録音をピック（曜日毎）
      var picks = { mon: null, wed: null, fri: null };
      inWeek.forEach(function (r) {
        var dow = new Date(r.createdAt).getDay();
        if (dow === 1) picks.mon = (!picks.mon || r.createdAt > picks.mon.createdAt) ? r : picks.mon;
        else if (dow === 3) picks.wed = (!picks.wed || r.createdAt > picks.wed.createdAt) ? r : picks.wed;
        else if (dow === 5) picks.fri = (!picks.fri || r.createdAt > picks.fri.createdAt) ? r : picks.fri;
      });
      // 揃わない曜日は inWeek から代替（最新から埋める）
      var sorted = inWeek.slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
      ['mon', 'wed', 'fri'].forEach(function (k) {
        if (!picks[k]) picks[k] = sorted.shift() || null;
      });
      var ids = ['mon', 'wed', 'fri']
        .map(function (k) { return picks[k] ? picks[k].id : null; })
        .filter(function (x) { return x !== null; });
      return {
        ready: ids.length > 0,
        reason: 'friday-collage-ready',
        candidateIds: ids,
        clipDurationSec: 50, // 40-60s 中央値
        picks: picks
      };
    });
  }

  function markCollageStitched() {
    lsSet(COLLAGE_LAST_LS, Date.now());
  }

  // -------------------------------------------------------------
  // 11. 補助 API
  // -------------------------------------------------------------
  function deleteRecording(id) {
    return idbDelete(id);
  }

  function configure(opts) {
    if (!opts || typeof opts !== 'object') return Object.assign({}, analysisCfg);
    Object.keys(opts).forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(ANALYSIS_DEFAULTS, k) && typeof opts[k] === 'number') {
        analysisCfg[k] = opts[k];
      }
    });
    return Object.assign({}, analysisCfg);
  }

  function getState() {
    return {
      recState: state.recState,
      startedAt: state.startedAt,
      bpm: state.bpm,
      pattern_id: state.pattern_id,
      memo: state.memo,
      mimeType: state.mimeType,
      lastError: state.lastError,
      cfg: Object.assign({}, analysisCfg)
    };
  }

  function setOnTick(fn) {
    state.onTick = (typeof fn === 'function') ? fn : null;
  }

  // クラッシュ復旧：ロード時に「未完了セッション」検出（recording 中にタブ閉じた等）
  function recoverIncompleteSession() {
    var sess = lsGet(LS_KEYS.REC_SESSION, null);
    if (sess && typeof sess.id === 'number') {
      // 残骸：LS のみクリア（IDB には put されてないので残骸なし）
      lsSet(LS_KEYS.REC_SESSION, null);
      return { recovered: true, abandonedSessionId: sess.id };
    }
    return { recovered: false };
  }

  // -------------------------------------------------------------
  // 12. 公開 API
  // -------------------------------------------------------------
  global.SteadyRecorder = {
    __version: 'v3.3.0r3-recorder-delayed-fb',
    // 命令書 export
    startRec: startRec,
    stopRec: stopRec,
    listRecordings: listRecordings,
    analyze: analyze,
    getReminderToday: getReminderToday,
    // 補助
    deleteRecording: deleteRecording,
    configure: configure,
    getState: getState,
    setOnTick: setOnTick,
    markReminderShownToday: markReminderShownToday,
    recoverIncompleteSession: recoverIncompleteSession,
    // v3.3.0r3 #7：遅延フィードバック（Metcalfe 2009）+ 金曜 collage + 14件 prune
    getImmediateBinarySignal: getImmediateBinarySignal,
    scheduleDelayedFeedback: scheduleDelayedFeedback,
    getPendingDelayedFeedback: getPendingDelayedFeedback,
    markDelayedFeedbackShown: markDelayedFeedbackShown,
    pruneOldRecordings: pruneOldRecordings,
    getFridayCollageCandidates: getFridayCollageCandidates,
    markCollageStitched: markCollageStitched,
    DELAY_FEEDBACK_HOURS: DELAY_FEEDBACK_HOURS,
    MAX_RECORDINGS: MAX_RECORDINGS,
    // 内部公開（テスト/監査用）
    _internal: {
      LS_KEYS: LS_KEYS,
      ANALYSIS_DEFAULTS: ANALYSIS_DEFAULTS,
      pickMimeType: pickMimeType,
      computeRMSEnvelope: computeRMSEnvelope,
      detectOnsets: detectOnsets,
      mergeChannelsMono: mergeChannelsMono,
      openDB: openDB,
      idbListAll: idbListAll
    }
  };

  // 起動時に未完了セッション復旧（副作用最小・LS のみ）
  try { recoverIncompleteSession(); } catch (_) {}
})(typeof window !== 'undefined' ? window : globalThis);
