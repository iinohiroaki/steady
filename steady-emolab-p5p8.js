/* =============================================================
   STEADY v3.2.0r2-block8 — SteadyEmoLab p5〜p8 + 公開 API
   - core.html L2760-4370 抜粋（B8 Run 2 / T-04 module split）
   - p5 Octopus / p6 Crash 4分 / p7 Ride Bell / p8 Subtractive
   - p5/p6 共通ヘルパ・p7/p8 共通ヘルパ・unmount・keyboard handler
   - toggleKbdHelp（B7 MED-01 fix Option A 適用済）
   - mount router・公開 API・DOM ready 初期化
   - 依存：steady-emolab-shared.js、steady-emolab-p1p4.js（先にロード必須）
   ============================================================= */

(function (global) {
  'use strict';

  // 順序保護：shared と p1p4 が両方ロード済かチェック
  if (!global.SteadyEmoLab || !global.SteadyEmoLab._shared_loaded) {
    if (global.STEADY_DEBUG) console.warn('[emolab] p5p8.js: shared module not loaded yet');
    return;
  }
  if (!global.SteadyEmoLab._p1p4_loaded) {
    if (global.STEADY_DEBUG) console.warn('[emolab] p5p8.js: p1p4 module not loaded yet');
    return;
  }
  if (global.SteadyEmoLab._p5p8_loaded) return;

  var H = global.SteadyEmoLab._helper;
  // shared から helper を local 名で取り出し（コード本体を最小書換で運用）
  var loadMidiSpec        = H.loadMidiSpec;
  var getPatternSpec      = H.getPatternSpec;
  var clampBpm            = H.clampBpm;
  var leaveActiveBlock    = H.leaveActiveBlock;
  var lsGetSafe           = H.lsGetSafe;
  var lsSetSafe           = H.lsSetSafe;
  var lsBumpPhase1Progress = H.lsBumpPhase1Progress;
  var notesToSteps        = H.notesToSteps;
  var buildKitFor         = H.buildKitFor;
  var disposeKit          = H.disposeKit;
  var ROWS                = H.ROWS;
  var STATE_CYCLE         = H.STATE_CYCLE;
  var STATE_VELOCITY      = H.STATE_VELOCITY;
  // p1p4.js から DOM helper を取得
  var renderControlsHtml    = H.renderControlsHtml;
  var renderProgressionHtml = H.renderProgressionHtml;
  var renderStepGridHtml    = H.renderStepGridHtml;
  var renderGrid            = H.renderGrid;
  var updateGridCurrent     = H.updateGridCurrent;
  var renderOnomato         = H.renderOnomato;
  var updateOnomatoActive   = H.updateOnomatoActive;
  var setActiveProgression  = H.setActiveProgression;

  // mountP1-P4 は p1p4.js の公開 API から取得（mount router 用）
  var mountP1 = global.SteadyEmoLab.mountP1;
  var mountP2 = global.SteadyEmoLab.mountP2;
  var mountP3 = global.SteadyEmoLab.mountP3;
  var mountP4 = global.SteadyEmoLab.mountP4;

  // ---------------------------------------------------------
  // p5 Octopus（B6 / 両手両足同時系・8 分音符オール埋め＋BD16n 連打）
  //   - kick_a/kick_b ラウンドロビンで 16n 連打衝突を回避
  //   - density meter（密度可視化）
  //   - onomato strip（ドド／チ／タッ／ドド）
  // ---------------------------------------------------------
  function mountP5(patternId, rootEl, opts) {
    var spec = getPatternSpec(patternId);
    if (!spec) {
      rootEl.innerHTML = '<p class="muted-text small">MIDI spec が読み込めませんでした。</p>';
      return null;
    }
    var BLOCK_ID = 'B6_p5';
    var STAGE_ID = opts.patternStageId || 'octopus';
    var LS_KEYS = {
      bpm:        'steady_p5_octopus_bpm_v3_2',
      lastPlayed: 'steady_p5_octopus_lastPlayed_v3_2',
      steps:      'steady_p5_octopus_steps_v3_2'
    };
    var DEFAULT_BPM = 115;
    var bpm = clampBpm(lsGetSafe(LS_KEYS.bpm, DEFAULT_BPM)) || DEFAULT_BPM;
    var savedSteps = lsGetSafe(LS_KEYS.steps, null);
    var validShape = !!(savedSteps && typeof savedSteps === 'object' &&
      ROWS.every(function (r) { return Array.isArray(savedSteps[r]) && savedSteps[r].length === 16; }));
    var initialSteps = validShape ? savedSteps : notesToSteps(spec.midi_notes);

    var sec = document.createElement('section');
    sec.className = 'emo-lab-pattern';
    sec.id = 'emo-lab-p5';
    sec.setAttribute('data-block', BLOCK_ID);
    var dkVizEnabled = lsGetSafe('steady_p5_octopus_dk_viz_enabled_v3_2', true);
    if (dkVizEnabled !== false) dkVizEnabled = true;

    sec.innerHTML = renderControlsHtml('p5', bpm, spec) +
      renderProgressionHtml('p5', spec.bpm_recommended_progression, bpm) +
      '<div class="emo-density-meter" aria-label="密度メーター（埋まり具合）">' +
        '<span class="emo-density-label">密度</span>' +
        '<div class="emo-density-bar"><div class="emo-density-fill" id="emo-density-fill-p5" style="width:0%"></div></div>' +
        '<span class="emo-density-value" id="emo-density-value-p5">0%</span>' +
      '</div>' +
      '<div class="emo-dk-viz-toggle">' +
        '<button type="button" class="emo-dk-viz-btn' + (dkVizEnabled ? ' active' : '') + '" aria-pressed="' + dkVizEnabled + '" id="dk-viz-toggle-p5">ダブルキック表示：' + (dkVizEnabled ? 'ON' : 'OFF') + '</button>' +
      '</div>' +
      renderStepGridHtml('p5') +
      '<div class="emo-double-kick-visualizer' + (dkVizEnabled ? '' : ' is-hidden') + '" id="dk-viz-p5" aria-label="ダブルキック可視化（BD直下 16 ステップ 2 ドット）">' +
        Array.apply(null, { length: 16 }).map(function (_, i) {
          return '<div class="emo-dk-cell" data-col="' + i + '"><span class="emo-dk-dot emo-dk-dot-1"></span><span class="emo-dk-dot emo-dk-dot-2"></span></div>';
        }).join('') +
      '</div>' +
      '<div class="emo-kick-pair-indicator dev-only" id="kick-pair-p5" aria-label="kick_a/kick_b ラウンドロビン状態（開発用）">' +
        '<span class="emo-kick-pair-lamp emo-kick-pair-a" data-kick="a">A</span>' +
        '<span class="emo-kick-pair-lamp emo-kick-pair-b" data-kick="b">B</span>' +
      '</div>' +
      '<div class="emo-onomato" id="emo-onomato-p5" data-block="' + BLOCK_ID + '" data-pattern="' + patternId + '" aria-label="オノマトペ進行"></div>';
    rootEl.appendChild(sec);

    var bpmInput = sec.querySelector('.emo-bpm-slider');
    var bpmValue = sec.querySelector('.emo-bpm-value');
    var playBtn = sec.querySelector('.emo-play-btn');
    var resetBtn = sec.querySelector('.emo-reset-btn');
    var grid = sec.querySelector('.emo-step-seq');
    var onomato = sec.querySelector('.emo-onomato');
    var densityFill = sec.querySelector('#emo-density-fill-p5');
    var densityValue = sec.querySelector('#emo-density-value-p5');
    var dkVizContainer = sec.querySelector('#dk-viz-p5');
    var dkVizBtn = sec.querySelector('#dk-viz-toggle-p5');
    var kickPairContainer = sec.querySelector('#kick-pair-p5');

    bpmInput.value = bpm;
    bpmValue.textContent = String(bpm);

    var state = { bpm: bpm, steps: initialSteps, isPlaying: false, currentStep: -1,
      kit: null, repeatId: null, cleanupBound: null, kickToggle: 0,
      playStartedAt: 0, playElapsed: 0,
      dkVizEnabled: dkVizEnabled };
    renderGrid(grid, state.steps);
    renderOnomato(onomato, spec.onomatopoeia_sync || []);
    setActiveProgression(sec, bpm);
    updateDensityMeter(state.steps, densityFill, densityValue);
    updateDoubleKickVisualizer(dkVizContainer, state.steps);

    // dk_viz toggle
    if (dkVizBtn) {
      dkVizBtn.addEventListener('click', function () {
        state.dkVizEnabled = !state.dkVizEnabled;
        lsSetSafe('steady_p5_octopus_dk_viz_enabled_v3_2', state.dkVizEnabled);
        dkVizBtn.setAttribute('aria-pressed', state.dkVizEnabled ? 'true' : 'false');
        dkVizBtn.classList.toggle('active', state.dkVizEnabled);
        dkVizBtn.textContent = 'ダブルキック表示：' + (state.dkVizEnabled ? 'ON' : 'OFF');
        if (dkVizContainer) dkVizContainer.classList.toggle('is-hidden', !state.dkVizEnabled);
      });
    }
    // dev-only kick pair indicator: window.STEADY_DEV=true で表示
    if (kickPairContainer && global.STEADY_DEV === true) {
      kickPairContainer.classList.add('is-visible');
    }

    function persistSteps() { try { lsSetSafe(LS_KEYS.steps, state.steps); } catch (_) {} }

    grid.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.emo-step');
      if (!btn) return;
      var row = btn.getAttribute('data-row');
      var col = parseInt(btn.getAttribute('data-col'), 10);
      if (!row || isNaN(col) || !state.steps[row]) return;
      var cur = state.steps[row][col] || 'off';
      var next = STATE_CYCLE[(STATE_CYCLE.indexOf(cur) + 1) % STATE_CYCLE.length];
      state.steps[row][col] = next;
      // UX-17：data-state を同期実行（CSS spring transition で 1 frame 以内に visual 反映）
      btn.setAttribute('data-state', next);
      btn.dataset.state = next;
      persistSteps();
      updateDensityMeter(state.steps, densityFill, densityValue);
      if (row === 'BD') updateDoubleKickVisualizer(dkVizContainer, state.steps);
      if (state.isPlaying) reschedule();
    });

    bindBpmControls(sec, state, bpmInput, bpmValue, LS_KEYS.bpm);

    playBtn.addEventListener('click', function () { if (state.isPlaying) stopP5(); else startP5(); });
    resetBtn.addEventListener('click', function () {
      state.steps = notesToSteps(spec.midi_notes);
      renderGrid(grid, state.steps);
      persistSteps();
      updateDensityMeter(state.steps, densityFill, densityValue);
      if (state.isPlaying) reschedule();
    });

    function startP5() {
      if (!global.Tone) { if (global.STEADY_DEBUG) console.warn('[emolab] Tone.js not loaded'); return; }
      if (global.__steady_active_block_id && global.__steady_active_block_id !== BLOCK_ID) leaveActiveBlock();
      global.__steady_active_block_id = BLOCK_ID;
      try {
        if (global.Tone.context && global.Tone.context.state !== 'running') global.Tone.context.resume();
        if (typeof global.Tone.start === 'function') global.Tone.start();
      } catch (_) {}
      state.kit = buildKitFor(patternId);
      if (!state.kit) return;
      state.kickToggle = 0;
      try {
        global.Tone.Transport.cancel(0);
        global.Tone.Transport.bpm.value = state.bpm;
        global.Tone.Transport.loopEnd = '1m';
        global.Tone.Transport.loop = true;
        global.Tone.Transport.swing = 0;
      } catch (_) {}
      schedule();
      try { global.Tone.Transport.start('+0.05'); } catch (_) {}
      state.isPlaying = true;
      state.playStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      state.playElapsed = 0;
      playBtn.textContent = '一時停止';
      playBtn.setAttribute('aria-pressed', 'true');
      lsSetSafe(LS_KEYS.lastPlayed, new Date().toISOString());
      state.cleanupBound = function () { stopP5(); };
      document.addEventListener('steady:block-leave', state.cleanupBound, { once: true });
    }

    function reschedule() {
      try {
        if (state.repeatId !== null && state.repeatId !== undefined) {
          global.Tone.Transport.clear(state.repeatId);
          state.repeatId = null;
        }
        global.Tone.Transport.cancel(0);
      } catch (_) {}
      schedule();
    }

    function schedule() {
      if (!global.Tone || !state.kit) return;
      var stepIdx = -1;
      state.repeatId = global.Tone.Transport.scheduleRepeat(function (time) {
        stepIdx = (stepIdx + 1) % 16;
        var sx = stepIdx;
        var bdState = state.steps['BD'][sx];
        var firedKickKey = null;
        if (bdState !== 'off') {
          firedKickKey = (state.kickToggle++ % 2 === 0) ? 'a' : 'b';
          var k = firedKickKey === 'a' ? state.kit.kick_a : state.kit.kick_b;
          if (k) { try { k.triggerAttackRelease('C2', '8n', time, STATE_VELOCITY[bdState]); } catch (_) {} }
        }
        var sdState = state.steps['SD'][sx];
        if (sdState !== 'off' && state.kit.snare) {
          try { state.kit.snare.triggerAttackRelease('16n', time, STATE_VELOCITY[sdState]); } catch (_) {}
        }
        var hhState = state.steps['HH'][sx];
        if (hhState !== 'off' && state.kit.hihat) {
          try { state.kit.hihat.triggerAttackRelease('F#2', '16n', time, STATE_VELOCITY[hhState]); } catch (_) {}
        }
        global.Tone.Draw.schedule(function () {
          state.currentStep = sx;
          updateGridCurrent(grid, sx);
          if (state.dkVizEnabled) updateDoubleKickVisualizerActive(dkVizContainer, sx);
          if (firedKickKey) flashKickPairLamp(kickPairContainer, firedKickKey);
          var beat = Math.floor(sx / 4);
          updateOnomatoActive(onomato, beat);
          if (state.playStartedAt > 0) {
            var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            var elapsed = now - state.playStartedAt;
            if (elapsed >= 30000 && state.playElapsed < 30000) {
              lsBumpPhase1Progress(STAGE_ID, 1, 100);
              if (typeof opts.onProgressTick === 'function') opts.onProgressTick();
            }
            state.playElapsed = elapsed;
          }
        }, time);
        try {
          var ts = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          global.SteadyWobble.capture(BLOCK_ID, [ts], []);
        } catch (_) {}
      }, '16n', 0);
    }

    function stopP5() {
      try {
        if (global.Tone && global.Tone.Transport) {
          global.Tone.Transport.stop();
          if (state.repeatId !== null && state.repeatId !== undefined) {
            try { global.Tone.Transport.clear(state.repeatId); } catch (_) {}
            state.repeatId = null;
          }
          global.Tone.Transport.cancel(0);
        }
      } catch (_) {}
      disposeKit(state.kit);
      state.kit = null;
      state.kickToggle = 0;
      state.isPlaying = false;
      state.currentStep = -1;
      playBtn.textContent = '再生';
      playBtn.setAttribute('aria-pressed', 'false');
      grid.querySelectorAll('.emo-step.is-current').forEach(function (e) { e.classList.remove('is-current'); });
      onomato.querySelectorAll('span[data-active="true"]').forEach(function (e) { e.setAttribute('data-active', 'false'); });
      if (state.cleanupBound) {
        document.removeEventListener('steady:block-leave', state.cleanupBound);
        state.cleanupBound = null;
      }
      if (global.__steady_active_block_id === BLOCK_ID) global.__steady_active_block_id = null;
    }

    return { stop: stopP5, dispose: stopP5 };
  }

  // ---------------------------------------------------------
  // p6 Crash 4 分（B6 / 4 分音符全クラッシュ・読み取り専用）
  //   - 4n callback で BD/SD 交互＋Crash 同時発火
  //   - intensity meter（再生継続秒数で伸びる）
  //   - onomato strip（シャーン × 4）
  //   - crash dispose は disposeKit 経由（1600ms 待機）
  // ---------------------------------------------------------
  function mountP6(patternId, rootEl, opts) {
    var spec = getPatternSpec(patternId);
    if (!spec) {
      rootEl.innerHTML = '<p class="muted-text small">MIDI spec が読み込めませんでした。</p>';
      return null;
    }
    var BLOCK_ID = 'B6_p6';
    var STAGE_ID = opts.patternStageId || 'crash4';
    var LS_KEYS = {
      bpm:        'steady_p6_crash_quarter_bpm_v3_2',
      lastPlayed: 'steady_p6_crash_quarter_lastPlayed_v3_2'
    };
    var DEFAULT_BPM = 140;
    var bpm = clampBpm(lsGetSafe(LS_KEYS.bpm, DEFAULT_BPM)) || DEFAULT_BPM;

    var sec = document.createElement('section');
    sec.className = 'emo-lab-pattern';
    sec.id = 'emo-lab-p6';
    sec.setAttribute('data-block', BLOCK_ID);
    sec.innerHTML = renderControlsHtml('p6', bpm, spec) +
      renderProgressionHtml('p6', spec.bpm_recommended_progression, bpm) +
      '<div class="emo-crash-readonly" role="img" aria-label="4 拍 Crash 構造（読み取り専用）">' +
        '<div class="emo-crash-beat" data-beat="0"><span class="emo-crash-ring"></span><span class="emo-crash-base bd">B</span></div>' +
        '<div class="emo-crash-beat" data-beat="1"><span class="emo-crash-ring"></span><span class="emo-crash-base sd">S</span></div>' +
        '<div class="emo-crash-beat" data-beat="2"><span class="emo-crash-ring"></span><span class="emo-crash-base bd">B</span></div>' +
        '<div class="emo-crash-beat" data-beat="3"><span class="emo-crash-ring"></span><span class="emo-crash-base sd">S</span></div>' +
      '</div>' +
      '<div class="emo-intensity-meter" aria-label="強度メーター（継続再生時間で伸びる）">' +
        '<span class="emo-intensity-label">強度</span>' +
        '<div class="emo-intensity-bar"><div class="emo-intensity-fill" id="emo-intensity-fill-p6" style="width:0%"></div></div>' +
        '<span class="emo-intensity-value" id="emo-intensity-value-p6">0s</span>' +
      '</div>' +
      '<div class="emo-onomato" id="emo-onomato-p6" data-block="' + BLOCK_ID + '" data-pattern="' + patternId + '" aria-label="オノマトペ進行"></div>';
    rootEl.appendChild(sec);

    var bpmInput = sec.querySelector('.emo-bpm-slider');
    var bpmValue = sec.querySelector('.emo-bpm-value');
    var playBtn = sec.querySelector('.emo-play-btn');
    var resetBtn = sec.querySelector('.emo-reset-btn');
    var onomato = sec.querySelector('.emo-onomato');
    var intensityFill = sec.querySelector('#emo-intensity-fill-p6');
    var intensityValue = sec.querySelector('#emo-intensity-value-p6');

    bpmInput.value = bpm;
    bpmValue.textContent = String(bpm);
    setActiveProgression(sec, bpm);

    var state = { bpm: bpm, isPlaying: false, currentBeat: -1,
      kit: null, repeatId: null, cleanupBound: null,
      playStartedAt: 0, playElapsed: 0, intensityRafId: null };
    renderOnomato(onomato, spec.onomatopoeia_sync || []);

    bindBpmControls(sec, state, bpmInput, bpmValue, LS_KEYS.bpm);
    playBtn.addEventListener('click', function () { if (state.isPlaying) stopP6(); else startP6(); });
    // resetBtn は読み取り専用パターン：BPM のみ既定へ
    resetBtn.addEventListener('click', function () {
      state.bpm = DEFAULT_BPM;
      bpmInput.value = DEFAULT_BPM;
      bpmValue.textContent = String(DEFAULT_BPM);
      lsSetSafe(LS_KEYS.bpm, DEFAULT_BPM);
      if (global.Tone && global.Tone.Transport) { try { global.Tone.Transport.bpm.value = DEFAULT_BPM; } catch (_) {} }
      setActiveProgression(sec, DEFAULT_BPM);
    });

    function startP6() {
      if (!global.Tone) { if (global.STEADY_DEBUG) console.warn('[emolab] Tone.js not loaded'); return; }
      if (global.__steady_active_block_id && global.__steady_active_block_id !== BLOCK_ID) leaveActiveBlock();
      global.__steady_active_block_id = BLOCK_ID;
      try {
        if (global.Tone.context && global.Tone.context.state !== 'running') global.Tone.context.resume();
        if (typeof global.Tone.start === 'function') global.Tone.start();
      } catch (_) {}
      state.kit = buildKitFor(patternId);
      if (!state.kit) return;
      try {
        global.Tone.Transport.cancel(0);
        global.Tone.Transport.bpm.value = state.bpm;
        global.Tone.Transport.loopEnd = '1m';
        global.Tone.Transport.loop = true;
        global.Tone.Transport.swing = 0;
      } catch (_) {}
      schedule();
      try { global.Tone.Transport.start('+0.05'); } catch (_) {}
      state.isPlaying = true;
      state.playStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      state.playElapsed = 0;
      playBtn.textContent = '一時停止';
      playBtn.setAttribute('aria-pressed', 'true');
      lsSetSafe(LS_KEYS.lastPlayed, new Date().toISOString());
      state.cleanupBound = function () { stopP6(); };
      document.addEventListener('steady:block-leave', state.cleanupBound, { once: true });
      tickIntensity();
    }

    function tickIntensity() {
      if (!state.isPlaying) return;
      var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      var elapsed = Math.max(0, now - state.playStartedAt);
      var pct = Math.min(100, Math.round(elapsed / 30000 * 100));
      if (intensityFill) intensityFill.style.width = pct + '%';
      if (intensityValue) intensityValue.textContent = Math.min(99, Math.floor(elapsed / 1000)) + 's';
      if (global.requestAnimationFrame) {
        state.intensityRafId = global.requestAnimationFrame(tickIntensity);
      }
    }

    function schedule() {
      if (!global.Tone || !state.kit) return;
      var beatIdx = -1;
      state.repeatId = global.Tone.Transport.scheduleRepeat(function (time) {
        beatIdx = (beatIdx + 1) % 4;
        var bx = beatIdx;
        // BD/SD 交互（拍 % 2 === 0 → BD、奇数 → SD）
        if (bx % 2 === 0 && state.kit.kick) {
          try { state.kit.kick.triggerAttackRelease('C2', '8n', time, 0.95); } catch (_) {}
        } else if (bx % 2 === 1 && state.kit.snare) {
          try { state.kit.snare.triggerAttackRelease('16n', time, 0.95); } catch (_) {}
        }
        // 全拍 Crash
        if (state.kit.crash) {
          try { state.kit.crash.triggerAttackRelease('C3', '4n', time, 0.95); } catch (_) {}
        }
        global.Tone.Draw.schedule(function () {
          state.currentBeat = bx;
          updateCrashBeatActive(sec, bx);
          updateOnomatoActive(onomato, bx);
          if (state.playStartedAt > 0) {
            var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            var elapsed = now - state.playStartedAt;
            if (elapsed >= 30000 && state.playElapsed < 30000) {
              lsBumpPhase1Progress(STAGE_ID, 1, 100);
              if (typeof opts.onProgressTick === 'function') opts.onProgressTick();
            }
            state.playElapsed = elapsed;
          }
        }, time);
        try {
          var ts = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          global.SteadyWobble.capture(BLOCK_ID, [ts], []);
        } catch (_) {}
      }, '4n', 0);
    }

    function stopP6() {
      try {
        if (global.Tone && global.Tone.Transport) {
          global.Tone.Transport.stop();
          if (state.repeatId !== null && state.repeatId !== undefined) {
            try { global.Tone.Transport.clear(state.repeatId); } catch (_) {}
            state.repeatId = null;
          }
          global.Tone.Transport.cancel(0);
        }
      } catch (_) {}
      // crash は disposeKit 内で 1600ms 待機して dispose
      disposeKit(state.kit);
      state.kit = null;
      state.isPlaying = false;
      state.currentBeat = -1;
      playBtn.textContent = '再生';
      playBtn.setAttribute('aria-pressed', 'false');
      onomato.querySelectorAll('span[data-active="true"]').forEach(function (e) { e.setAttribute('data-active', 'false'); });
      sec.querySelectorAll('.emo-crash-beat.is-current').forEach(function (e) { e.classList.remove('is-current'); });
      if (state.intensityRafId && global.cancelAnimationFrame) {
        try { global.cancelAnimationFrame(state.intensityRafId); } catch (_) {}
        state.intensityRafId = null;
      }
      if (intensityFill) intensityFill.style.width = '0%';
      if (intensityValue) intensityValue.textContent = '0s';
      if (state.cleanupBound) {
        document.removeEventListener('steady:block-leave', state.cleanupBound);
        state.cleanupBound = null;
      }
      if (global.__steady_active_block_id === BLOCK_ID) global.__steady_active_block_id = null;
    }

    return { stop: stopP6, dispose: stopP6 };
  }

  // ---------------------------------------------------------
  // p7 Ride Bell（B7 / 4 分音符ベル＋BD/SD交互・読み取り専用）
  //   - 4n callback で BD(偶数拍)/SD(奇数拍) + ride_bell 同時発火
  //   - bell_resonance_visualizer：発火時に同心円拡散アニメ
  //   - onomato strip（カン × 4・金色変化）
  //   - ride_bell decay 0.4s なので setTimeout 待機不要
  // ---------------------------------------------------------
  function mountP7(patternId, rootEl, opts) {
    var spec = getPatternSpec(patternId);
    if (!spec) {
      rootEl.innerHTML = '<p class="muted-text small">MIDI spec が読み込めませんでした。</p>';
      return null;
    }
    var BLOCK_ID = 'B7_p7';
    var STAGE_ID = opts.patternStageId || 'ride_bell';
    var LS_KEYS = {
      bpm:        'steady_p7_ride_bell_bpm_v3_2',
      lastPlayed: 'steady_p7_ride_bell_lastPlayed_v3_2'
    };
    var DEFAULT_BPM = 120;
    var bpm = clampBpm(lsGetSafe(LS_KEYS.bpm, DEFAULT_BPM)) || DEFAULT_BPM;

    var sec = document.createElement('section');
    sec.className = 'emo-lab-pattern';
    sec.id = 'emo-lab-p7';
    sec.setAttribute('data-block', BLOCK_ID);
    sec.innerHTML = renderControlsHtml('p7', bpm, spec) +
      renderProgressionHtml('p7', spec.bpm_recommended_progression, bpm) +
      '<div class="emo-bell-readonly" role="img" aria-label="4 拍 Ride Bell 構造（読み取り専用）">' +
        '<div class="emo-bell-beat" data-beat="0">' +
          '<svg class="emo-bell-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3 C 7 3 5 5 5 9 L 4 13 L 16 13 L 15 9 C 15 5 13 3 10 3 Z M 9 14 L 11 14 L 11 16 L 9 16 Z" fill="currentColor"></path></svg>' +
          '<span class="emo-bell-resonance"></span>' +
          '<span class="emo-bell-base bd">B</span>' +
        '</div>' +
        '<div class="emo-bell-beat" data-beat="1">' +
          '<svg class="emo-bell-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3 C 7 3 5 5 5 9 L 4 13 L 16 13 L 15 9 C 15 5 13 3 10 3 Z M 9 14 L 11 14 L 11 16 L 9 16 Z" fill="currentColor"></path></svg>' +
          '<span class="emo-bell-resonance"></span>' +
          '<span class="emo-bell-base sd">S</span>' +
        '</div>' +
        '<div class="emo-bell-beat" data-beat="2">' +
          '<svg class="emo-bell-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3 C 7 3 5 5 5 9 L 4 13 L 16 13 L 15 9 C 15 5 13 3 10 3 Z M 9 14 L 11 14 L 11 16 L 9 16 Z" fill="currentColor"></path></svg>' +
          '<span class="emo-bell-resonance"></span>' +
          '<span class="emo-bell-base bd">B</span>' +
        '</div>' +
        '<div class="emo-bell-beat" data-beat="3">' +
          '<svg class="emo-bell-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3 C 7 3 5 5 5 9 L 4 13 L 16 13 L 15 9 C 15 5 13 3 10 3 Z M 9 14 L 11 14 L 11 16 L 9 16 Z" fill="currentColor"></path></svg>' +
          '<span class="emo-bell-resonance"></span>' +
          '<span class="emo-bell-base sd">S</span>' +
        '</div>' +
      '</div>' +
      '<div class="emo-onomato emo-onomato-bell" id="emo-onomato-p7" data-block="' + BLOCK_ID + '" data-pattern="' + patternId + '" aria-label="オノマトペ進行(カン × 4)"></div>';
    rootEl.appendChild(sec);

    var bpmInput = sec.querySelector('.emo-bpm-slider');
    var bpmValue = sec.querySelector('.emo-bpm-value');
    var playBtn = sec.querySelector('.emo-play-btn');
    var resetBtn = sec.querySelector('.emo-reset-btn');
    var onomato = sec.querySelector('.emo-onomato');

    bpmInput.value = bpm;
    bpmValue.textContent = String(bpm);
    setActiveProgression(sec, bpm);

    var state = { bpm: bpm, isPlaying: false, currentBeat: -1,
      kit: null, repeatId: null, cleanupBound: null,
      playStartedAt: 0, playElapsed: 0 };
    renderOnomato(onomato, spec.onomatopoeia_sync || []);

    bindBpmControls(sec, state, bpmInput, bpmValue, LS_KEYS.bpm);
    playBtn.addEventListener('click', function () { if (state.isPlaying) stopP7(); else startP7(); });
    // resetBtn は読み取り専用パターン：BPM のみ既定へ
    resetBtn.addEventListener('click', function () {
      state.bpm = DEFAULT_BPM;
      bpmInput.value = DEFAULT_BPM;
      bpmValue.textContent = String(DEFAULT_BPM);
      lsSetSafe(LS_KEYS.bpm, DEFAULT_BPM);
      if (global.Tone && global.Tone.Transport) { try { global.Tone.Transport.bpm.value = DEFAULT_BPM; } catch (_) {} }
      setActiveProgression(sec, DEFAULT_BPM);
    });

    function startP7() {
      if (!global.Tone) { if (global.STEADY_DEBUG) console.warn('[emolab] Tone.js not loaded'); return; }
      if (global.__steady_active_block_id && global.__steady_active_block_id !== BLOCK_ID) leaveActiveBlock();
      global.__steady_active_block_id = BLOCK_ID;
      try {
        if (global.Tone.context && global.Tone.context.state !== 'running') global.Tone.context.resume();
        if (typeof global.Tone.start === 'function') global.Tone.start();
      } catch (_) {}
      state.kit = buildKitFor(patternId);
      if (!state.kit) return;
      try {
        global.Tone.Transport.cancel(0);
        global.Tone.Transport.bpm.value = state.bpm;
        global.Tone.Transport.loopEnd = '1m';
        global.Tone.Transport.loop = true;
        global.Tone.Transport.swing = 0;
      } catch (_) {}
      schedule();
      try { global.Tone.Transport.start('+0.05'); } catch (_) {}
      state.isPlaying = true;
      state.playStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      state.playElapsed = 0;
      playBtn.textContent = '一時停止';
      playBtn.setAttribute('aria-pressed', 'true');
      lsSetSafe(LS_KEYS.lastPlayed, new Date().toISOString());
      state.cleanupBound = function () { stopP7(); };
      document.addEventListener('steady:block-leave', state.cleanupBound, { once: true });
    }

    function schedule() {
      if (!global.Tone || !state.kit) return;
      var beatIdx = -1;
      state.repeatId = global.Tone.Transport.scheduleRepeat(function (time) {
        beatIdx = (beatIdx + 1) % 4;
        var bx = beatIdx;
        // BD/SD 交互（拍 % 2 === 0 → BD、奇数 → SD）
        if (bx % 2 === 0 && state.kit.kick) {
          try { state.kit.kick.triggerAttackRelease('C2', '8n', time, 0.9); } catch (_) {}
        } else if (bx % 2 === 1 && state.kit.snare) {
          try { state.kit.snare.triggerAttackRelease('16n', time, 0.9); } catch (_) {}
        }
        // 全拍 Ride Bell（高周波 MetalSynth・カン）
        if (state.kit.ride_bell) {
          try { state.kit.ride_bell.triggerAttackRelease('F3', '8n', time, 0.85); } catch (_) {}
        }
        global.Tone.Draw.schedule(function () {
          state.currentBeat = bx;
          updateBellBeatActive(sec, bx);
          updateOnomatoActive(onomato, bx);
          if (state.playStartedAt > 0) {
            var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            var elapsed = now - state.playStartedAt;
            if (elapsed >= 30000 && state.playElapsed < 30000) {
              lsBumpPhase1Progress(STAGE_ID, 1, 100);
              if (typeof opts.onProgressTick === 'function') opts.onProgressTick();
            }
            state.playElapsed = elapsed;
          }
        }, time);
        try {
          var ts = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          global.SteadyWobble.capture(BLOCK_ID, [ts], []);
        } catch (_) {}
      }, '4n', 0);
    }

    function stopP7() {
      try {
        if (global.Tone && global.Tone.Transport) {
          global.Tone.Transport.stop();
          if (state.repeatId !== null && state.repeatId !== undefined) {
            try { global.Tone.Transport.clear(state.repeatId); } catch (_) {}
            state.repeatId = null;
          }
          global.Tone.Transport.cancel(0);
        }
      } catch (_) {}
      // ride_bell decay 0.4s 短く dispose 即時可能
      disposeKit(state.kit);
      state.kit = null;
      state.isPlaying = false;
      state.currentBeat = -1;
      playBtn.textContent = '再生';
      playBtn.setAttribute('aria-pressed', 'false');
      onomato.querySelectorAll('span[data-active="true"]').forEach(function (e) { e.setAttribute('data-active', 'false'); });
      sec.querySelectorAll('.emo-bell-beat.is-current').forEach(function (e) { e.classList.remove('is-current'); });
      if (state.cleanupBound) {
        document.removeEventListener('steady:block-leave', state.cleanupBound);
        state.cleanupBound = null;
      }
      if (global.__steady_active_block_id === BLOCK_ID) global.__steady_active_block_id = null;
    }

    return { stop: stopP7, dispose: stopP7 };
  }

  // ---------------------------------------------------------
  // p8 Subtractive（B7 / 引き算 4 種ローテ・auto-rotate / manual-stay）
  //   - 8n callback で variation 別 midi_notes を発火
  //   - bar%4 で v1→v2→v3→v4 自動切替（auto-rotate）
  //   - manual-stay モードは選択 variation の 1 小節を loop
  //   - rotation_progress_indicator + variation_indicator + bpm_avoid_band hint
  //   - LS keys 5 種：bpm/rotation_mode/selected_variation/lastPlayed/played_variations
  //   - phase1_progress：4 種制覇で +25 ずつ計 +100
  // ---------------------------------------------------------
  function mountP8(patternId, rootEl, opts) {
    var spec = getPatternSpec(patternId);
    if (!spec) {
      rootEl.innerHTML = '<p class="muted-text small">MIDI spec が読み込めませんでした。</p>';
      return null;
    }
    var BLOCK_ID = 'B7_p8';
    var STAGE_ID = opts.patternStageId || 'subtractive';
    var LS_KEYS = {
      bpm:                 'steady_p8_subtractive_bpm_v3_2',
      rotationMode:        'steady_p8_subtractive_rotation_mode_v3_2',
      selectedVariation:   'steady_p8_subtractive_selected_variation_v3_2',
      lastPlayed:          'steady_p8_subtractive_lastPlayed_v3_2',
      playedVariations:    'steady_p8_subtractive_played_variations_v3_2'
    };
    var DEFAULT_BPM = 100;
    var bpm = clampBpm(lsGetSafe(LS_KEYS.bpm, DEFAULT_BPM)) || DEFAULT_BPM;
    if (bpm < 70) bpm = 70; else if (bpm > 130) bpm = 130;
    var rotationMode = lsGetSafe(LS_KEYS.rotationMode, 'auto-rotate');
    if (rotationMode !== 'auto-rotate' && rotationMode !== 'manual-stay') rotationMode = 'auto-rotate';
    var selectedVariation = lsGetSafe(LS_KEYS.selectedVariation, 'v1');
    if (['v1','v2','v3','v4'].indexOf(selectedVariation) === -1) selectedVariation = 'v1';
    var playedVariations = lsGetSafe(LS_KEYS.playedVariations, null);
    if (!playedVariations || typeof playedVariations !== 'object') playedVariations = { v1: 0, v2: 0, v3: 0, v4: 0 };

    var variations = spec.variations || [
      { id: 'v1', label: '2拍目SD抜き',   color: '#5B8DEF' },
      { id: 'v2', label: 'BD 1拍目のみ', color: '#4CAF50' },
      { id: 'v3', label: 'HH 表拍のみ',  color: '#FF9800' },
      { id: 'v4', label: '全要素半減',   color: '#9C27B0' }
    ];

    var sec = document.createElement('section');
    sec.className = 'emo-lab-pattern';
    sec.id = 'emo-lab-p8';
    sec.setAttribute('data-block', BLOCK_ID);

    var indicatorHtml = '<div class="emo-rotation-progress" id="rot-progress-p8" role="progressbar" aria-label="4 小節ローテ進行" aria-valuemin="1" aria-valuemax="4" aria-valuenow="1">';
    variations.forEach(function (v, i) {
      indicatorHtml += '<div class="emo-rot-step" data-bar="' + i + '" data-variation="' + v.id + '" style="--rot-color: ' + v.color + '"><span class="emo-rot-label">' + v.label + '</span></div>';
    });
    indicatorHtml += '</div>';

    var variationTabsHtml = '<div class="emo-variation-tabs" role="tablist" aria-label="引き算バリエーション選択">';
    variations.forEach(function (v) {
      var sel = v.id === selectedVariation ? 'true' : 'false';
      variationTabsHtml += '<button type="button" class="emo-variation-tab' + (v.id === selectedVariation ? ' active' : '') + '" role="tab" aria-selected="' + sel + '" data-variation="' + v.id + '">' + v.id.toUpperCase() + '：' + v.label + '</button>';
    });
    variationTabsHtml += '</div>';

    var rotationToggleHtml = '<div class="emo-rotation-mode" role="radiogroup" aria-label="ローテモード">' +
      '<button type="button" class="emo-rot-mode-btn' + (rotationMode === 'auto-rotate' ? ' active' : '') + '" role="radio" aria-checked="' + (rotationMode === 'auto-rotate') + '" data-mode="auto-rotate">自動ローテ</button>' +
      '<button type="button" class="emo-rot-mode-btn' + (rotationMode === 'manual-stay' ? ' active' : '') + '" role="radio" aria-checked="' + (rotationMode === 'manual-stay') + '" data-mode="manual-stay">手動固定</button>' +
      '</div>';

    sec.innerHTML = renderControlsHtml('p8', bpm, spec) +
      renderProgressionHtml('p8', spec.bpm_recommended_progression, bpm) +
      '<div class="emo-bpm-avoid-hint" aria-hidden="true" data-avoid-band="' + (spec.bpm_avoid_band || 85) + '" title="この帯は別ジャンル感が強くなります"></div>' +
      rotationToggleHtml +
      variationTabsHtml +
      indicatorHtml +
      '<div class="emo-onomato emo-onomato-subtractive" id="emo-onomato-p8" data-block="' + BLOCK_ID + '" data-pattern="' + patternId + '" aria-label="オノマトペ進行(14 syllables)"></div>';
    rootEl.appendChild(sec);

    var bpmInput = sec.querySelector('.emo-bpm-slider');
    var bpmValue = sec.querySelector('.emo-bpm-value');
    var playBtn = sec.querySelector('.emo-play-btn');
    var resetBtn = sec.querySelector('.emo-reset-btn');
    var onomato = sec.querySelector('.emo-onomato');

    // BPM slider sub-range（70-130）
    if (bpmInput) {
      try { bpmInput.min = 70; bpmInput.max = 130; } catch (_) {}
    }
    bpmInput.value = bpm;
    bpmValue.textContent = String(bpm);
    setActiveProgression(sec, bpm);

    var state = {
      bpm: bpm, rotationMode: rotationMode, selectedVariation: selectedVariation,
      currentVariation: 'v1', currentBar: 0,
      isPlaying: false, kit: null, repeatId: null, cleanupBound: null,
      playStartedAt: 0, playElapsed: 0,
      playedVariations: playedVariations, completedVariationsThisSession: {},
      // T-03 / MED-02 hotfix: variation 切替時刻（30 秒連続再生検知の汎用化用）
      variationStartedAt: 0
    };
    renderOnomatoP8(onomato, spec.onomatopoeia_sync || []);
    updateRotationIndicator(sec, state.currentVariation);
    updateVariationTabs(sec, state.rotationMode === 'manual-stay' ? state.selectedVariation : state.currentVariation);

    // BPM input：70-130 専用 clamp
    bpmInput.addEventListener('input', function () {
      var v = parseInt(bpmInput.value, 10);
      if (!Number.isFinite(v) || v < 70 || v > 130) { bpmInput.value = state.bpm; return; }
      state.bpm = v;
      bpmValue.textContent = String(v);
      lsSetSafe(LS_KEYS.bpm, v);
      if (global.Tone && global.Tone.Transport) { try { global.Tone.Transport.bpm.value = v; } catch (_) {} }
      setActiveProgression(sec, v);
    });
    sec.querySelectorAll('.emo-bpm-step').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = parseInt(b.getAttribute('data-bpm'), 10);
        if (!Number.isFinite(v) || v < 70 || v > 130) return;
        state.bpm = v;
        bpmInput.value = v;
        bpmValue.textContent = String(v);
        lsSetSafe(LS_KEYS.bpm, v);
        if (global.Tone && global.Tone.Transport) { try { global.Tone.Transport.bpm.value = v; } catch (_) {} }
        setActiveProgression(sec, v);
      });
    });

    // rotation mode toggle
    sec.querySelectorAll('.emo-rot-mode-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = b.getAttribute('data-mode');
        if (m !== 'auto-rotate' && m !== 'manual-stay') return;
        state.rotationMode = m;
        lsSetSafe(LS_KEYS.rotationMode, m);
        sec.querySelectorAll('.emo-rot-mode-btn').forEach(function (bb) {
          var isActive = bb.getAttribute('data-mode') === m;
          bb.classList.toggle('active', isActive);
          bb.setAttribute('aria-checked', isActive ? 'true' : 'false');
        });
      });
    });

    // variation tabs
    sec.querySelectorAll('.emo-variation-tab').forEach(function (t) {
      t.addEventListener('click', function () {
        var v = t.getAttribute('data-variation');
        if (['v1','v2','v3','v4'].indexOf(v) === -1) return;
        state.selectedVariation = v;
        lsSetSafe(LS_KEYS.selectedVariation, v);
        if (state.rotationMode === 'manual-stay') {
          updateVariationTabs(sec, v);
          updateRotationIndicator(sec, v);
          // T-03 / MED-03 hotfix: tab 切替時に onomato を即時 sync（次 Tone.Draw を待たない）
          var idx = ['v1','v2','v3','v4'].indexOf(v);
          if (idx >= 0 && onomato) {
            updateOnomatoActiveByGlobalBeat(onomato, idx * 4);
          }
          // T-03 / MED-02 hotfix: tab 切替時に currentVariation と 30 秒検知タイマーを同期
          // （schedule callback の差分検知に依存すると次 step まで待つため即時同期）
          if (state.currentVariation !== v) {
            state.currentVariation = v;
            state.variationStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          }
        }
      });
    });

    playBtn.addEventListener('click', function () { if (state.isPlaying) stopP8(); else startP8(); });
    resetBtn.addEventListener('click', function () {
      state.bpm = DEFAULT_BPM;
      bpmInput.value = DEFAULT_BPM;
      bpmValue.textContent = String(DEFAULT_BPM);
      lsSetSafe(LS_KEYS.bpm, DEFAULT_BPM);
      if (global.Tone && global.Tone.Transport) { try { global.Tone.Transport.bpm.value = DEFAULT_BPM; } catch (_) {} }
      setActiveProgression(sec, DEFAULT_BPM);
    });

    // midi_notes を variation ごとに事前グルーピング
    var notesByVariation = { v1: [], v2: [], v3: [], v4: [] };
    (spec.midi_notes || []).forEach(function (n) {
      var v = n.variation;
      if (notesByVariation[v]) notesByVariation[v].push(n);
    });

    function startP8() {
      if (!global.Tone) { if (global.STEADY_DEBUG) console.warn('[emolab] Tone.js not loaded'); return; }
      if (global.__steady_active_block_id && global.__steady_active_block_id !== BLOCK_ID) leaveActiveBlock();
      global.__steady_active_block_id = BLOCK_ID;
      try {
        if (global.Tone.context && global.Tone.context.state !== 'running') global.Tone.context.resume();
        if (typeof global.Tone.start === 'function') global.Tone.start();
      } catch (_) {}
      state.kit = buildKitFor(patternId);
      if (!state.kit) return;
      try {
        global.Tone.Transport.cancel(0);
        global.Tone.Transport.bpm.value = state.bpm;
        // auto-rotate=4 小節 1 サイクル / manual-stay=1 小節
        global.Tone.Transport.loopEnd = state.rotationMode === 'auto-rotate' ? '4m' : '1m';
        global.Tone.Transport.loop = true;
        global.Tone.Transport.swing = 0; // 明示 0：前 block 汚染防止
      } catch (_) {}
      state.completedVariationsThisSession = {};
      // T-03 / MED-02 hotfix: 初回 variation の 30 秒タイマー起点
      // currentVariation = 'v1' で初期化されているため schedule callback での切替検知が起きず、
      // この明示初期化が無いと manual-stay 起動時に v1 の加算が永遠に走らない
      state.currentVariation = state.rotationMode === 'manual-stay' ? state.selectedVariation : 'v1';
      schedule();
      try { global.Tone.Transport.start('+0.05'); } catch (_) {}
      state.isPlaying = true;
      state.playStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      state.variationStartedAt = state.playStartedAt;
      state.playElapsed = 0;
      playBtn.textContent = '一時停止';
      playBtn.setAttribute('aria-pressed', 'true');
      lsSetSafe(LS_KEYS.lastPlayed, new Date().toISOString());
      state.cleanupBound = function () { stopP8(); };
      document.addEventListener('steady:block-leave', state.cleanupBound, { once: true });
    }

    function schedule() {
      if (!global.Tone || !state.kit) return;
      var stepCounter = -1;
      state.repeatId = global.Tone.Transport.scheduleRepeat(function (time) {
        stepCounter++;
        // 8n step → 1 小節 = 8 step。auto は 32 step（4 小節）／manual は 8 step（1 小節）
        var stepsPerBar = 8;
        var barIdx, currentVar;
        if (state.rotationMode === 'auto-rotate') {
          barIdx = Math.floor(stepCounter / stepsPerBar) % 4;
          currentVar = ['v1','v2','v3','v4'][barIdx];
        } else {
          barIdx = 0;
          currentVar = state.selectedVariation;
        }
        var stepInBar = stepCounter % stepsPerBar;

        // currentVariation 切替検知
        if (currentVar !== state.currentVariation) {
          state.currentVariation = currentVar;
          state.currentBar = barIdx;
          // T-03 / MED-02 hotfix: variation 切替時に開始時刻リセット（30 秒検知カウンタ初期化）
          state.variationStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          // CustomEvent dispatch
          try {
            var ev = new CustomEvent('steady:p8-variation-change', { detail: { variation: currentVar, bar: barIdx } });
            document.dispatchEvent(ev);
          } catch (_) {}
          // auto-rotate モード：1 サイクル完走（各 variation 1 小節再生）で即加算（既存挙動維持）
          if (state.rotationMode === 'auto-rotate' && !state.completedVariationsThisSession[currentVar]) {
            state.completedVariationsThisSession[currentVar] = true;
            state.playedVariations[currentVar] = (state.playedVariations[currentVar] || 0) + 1;
            lsSetSafe(LS_KEYS.playedVariations, state.playedVariations);
            // 4 種制覇判定（各 variation 最低 1 回再生で +25 加算・max 100）
            updatePhase1ProgressFromPlayedVariations();
          }
        }
        // T-03 / MED-02 hotfix: manual-stay モードでも 30 秒連続再生で playedVariations 加算
        // （セッション中 variation 切替前は 1 度だけ加算・auto-rotate は上で先に加算済みなのでスキップ）
        if (state.rotationMode === 'manual-stay' && !state.completedVariationsThisSession[currentVar] && state.variationStartedAt > 0) {
          var nowTs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          if (nowTs - state.variationStartedAt >= 30000) {
            state.completedVariationsThisSession[currentVar] = true;
            state.playedVariations[currentVar] = (state.playedVariations[currentVar] || 0) + 1;
            lsSetSafe(LS_KEYS.playedVariations, state.playedVariations);
            updatePhase1ProgressFromPlayedVariations();
          }
        }

        // この variation の 8n step に該当する notes を発火
        var notes = notesByVariation[currentVar] || [];
        // 各 note の time を 8n step に変換し、stepInBar と一致するもののみ発火
        notes.forEach(function (n) {
          var noteStep = stepFromBeatStr(n.time);
          if (noteStep === stepInBar) {
            fireNote(n, time);
          }
        });

        global.Tone.Draw.schedule(function () {
          updateRotationIndicator(sec, currentVar);
          updateVariationTabs(sec, currentVar);
          // T-07 LOW-4: 8 裏拍は onomato 更新を skip（4 分音符単位での表示更新に揃える）
          if (stepInBar % 2 !== 0) return;
          var beat = Math.floor(stepInBar / 2); // 8n の表/裏のうち表のみ抽出
          // onomatopoeia の time は bar:beat:sixteenth 形式・通算 global beat step (0..15) を計算
          // auto-rotate 中は barIdx 0..3 / manual-stay 中は selectedVariation の bar offset を使用
          var onomatoBarIdx = barIdx;
          if (state.rotationMode === 'manual-stay') {
            onomatoBarIdx = ['v1','v2','v3','v4'].indexOf(state.selectedVariation);
            if (onomatoBarIdx < 0) onomatoBarIdx = 0;
          }
          var globalBeatStep = onomatoBarIdx * 4 + beat;
          updateOnomatoActiveByGlobalBeat(onomato, globalBeatStep);
          if (state.playStartedAt > 0) {
            var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            var elapsed = now - state.playStartedAt;
            state.playElapsed = elapsed;
          }
        }, time);
        try {
          var ts = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          global.SteadyWobble.capture(BLOCK_ID, [ts], []);
        } catch (_) {}
      }, '8n', 0);
    }

    function fireNote(n, time) {
      if (!state.kit) return;
      var note = n.note;
      var vel = n.velocity || 0.7;
      try {
        if (note === 'C2' && state.kit.kick) {
          state.kit.kick.triggerAttackRelease('C2', '8n', time, vel);
        } else if (note === 'D2' && state.kit.snare) {
          state.kit.snare.triggerAttackRelease('16n', time, vel);
        } else if (note === 'F#2' && state.kit.hihat) {
          state.kit.hihat.triggerAttackRelease('F#2', '16n', time, vel);
        }
      } catch (_) {}
    }

    function updatePhase1ProgressFromPlayedVariations() {
      var played = state.playedVariations;
      var distinctCount = 0;
      ['v1','v2','v3','v4'].forEach(function (k) {
        if ((played[k] || 0) >= 1) distinctCount++;
      });
      // 4 種制覇進捗：each +25
      var prog = getPhase1Progress();
      var target = Math.min(100, distinctCount * 25);
      if (typeof prog[STAGE_ID] !== 'number' || prog[STAGE_ID] < target) {
        prog[STAGE_ID] = target;
        S.lsSet(S.LS_V32.PHASE1_PROGRESS, prog);
        if (typeof opts.onProgressTick === 'function') opts.onProgressTick();
      }
    }

    function stopP8() {
      try {
        if (global.Tone && global.Tone.Transport) {
          global.Tone.Transport.stop();
          if (state.repeatId !== null && state.repeatId !== undefined) {
            try { global.Tone.Transport.clear(state.repeatId); } catch (_) {}
            state.repeatId = null;
          }
          global.Tone.Transport.cancel(0);
          // swing リセット（次 block 汚染防止）
          try { global.Tone.Transport.swing = 0; } catch (_) {}
        }
      } catch (_) {}
      disposeKit(state.kit);
      state.kit = null;
      state.isPlaying = false;
      state.currentVariation = 'v1';
      state.currentBar = 0;
      playBtn.textContent = '再生';
      playBtn.setAttribute('aria-pressed', 'false');
      onomato.querySelectorAll('span[data-active="true"]').forEach(function (e) { e.setAttribute('data-active', 'false'); });
      sec.querySelectorAll('.emo-rot-step.is-current').forEach(function (e) { e.classList.remove('is-current'); });
      if (state.cleanupBound) {
        document.removeEventListener('steady:block-leave', state.cleanupBound);
        state.cleanupBound = null;
      }
      if (global.__steady_active_block_id === BLOCK_ID) global.__steady_active_block_id = null;
    }

    return { stop: stopP8, dispose: stopP8 };
  }

  // ---------------------------------------------------------
  // p7/p8 共通ヘルパ
  // ---------------------------------------------------------
  function updateBellBeatActive(sec, beatIdx) {
    sec.querySelectorAll('.emo-bell-beat').forEach(function (e) {
      var v = parseInt(e.getAttribute('data-beat'), 10);
      e.classList.toggle('is-current', v === beatIdx);
    });
  }
  function updateRotationIndicator(sec, variationId) {
    sec.querySelectorAll('.emo-rot-step').forEach(function (e) {
      var v = e.getAttribute('data-variation');
      e.classList.toggle('is-current', v === variationId);
    });
    var rot = sec.querySelector('.emo-rotation-progress');
    if (rot) {
      var idx = ['v1','v2','v3','v4'].indexOf(variationId);
      if (idx >= 0) rot.setAttribute('aria-valuenow', String(idx + 1));
    }
  }
  function updateVariationTabs(sec, variationId) {
    sec.querySelectorAll('.emo-variation-tab').forEach(function (t) {
      var isActive = t.getAttribute('data-variation') === variationId;
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }
  // p8: bars:beats:sixteenths → 8n step（1 小節 = 8 step）
  function stepFromBeatStr(timeStr) {
    if (typeof timeStr !== 'string') return null;
    var parts = timeStr.split(':');
    if (parts.length < 3) return null;
    var beat = parseInt(parts[1], 10);
    var sixteenth = parseInt(parts[2], 10);
    if (isNaN(beat) || isNaN(sixteenth)) return null;
    // 8n step：beat * 2 + (sixteenth >= 2 ? 1 : 0)
    return beat * 2 + (sixteenth >= 2 ? 1 : 0);
  }
  // p8: bar:beat:sixteenth → 16 step（1 cycle 4 bars × 4 beats）に変換
  function timeToGlobalBeat(timeStr) {
    if (typeof timeStr !== 'string') return null;
    var parts = timeStr.split(':');
    if (parts.length < 3) return null;
    var bars = parseInt(parts[0], 10);
    var beats = parseInt(parts[1], 10);
    if (isNaN(bars) || isNaN(beats)) return null;
    return bars * 4 + beats;
  }
  function renderOnomatoP8(rootEl, syncs) {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    if (!Array.isArray(syncs)) return;
    syncs.forEach(function (s) {
      var globalBeat = timeToGlobalBeat(s.time);
      var span = document.createElement('span');
      span.textContent = s.syllable || '';
      span.setAttribute('data-global-beat', String(globalBeat == null ? -1 : globalBeat));
      span.setAttribute('data-active', 'false');
      // 休符は薄表示
      // T-07 LOW-1 / Run 7 UX-08: 休符 `_` は SR 読み上げ対象外 aria-hidden="true"
      if (s.syllable === '_') {
        span.classList.add('emo-onomato-rest');
        span.setAttribute('aria-hidden', 'true');
      }
      rootEl.appendChild(span);
    });
  }
  function updateOnomatoActiveByGlobalBeat(rootEl, globalBeatStep) {
    if (!rootEl) return;
    var spans = rootEl.querySelectorAll('span[data-global-beat]');
    spans.forEach(function (sp) {
      var s = parseInt(sp.getAttribute('data-global-beat'), 10);
      sp.setAttribute('data-active', s === globalBeatStep ? 'true' : 'false');
    });
  }

  // ---------------------------------------------------------
  // p5/p6 共通ヘルパ
  // ---------------------------------------------------------
  function bindBpmControls(sec, state, bpmInput, bpmValue, lsKey) {
    bpmInput.addEventListener('input', function () {
      var v = clampBpm(bpmInput.value);
      if (v == null) { bpmInput.value = state.bpm; return; }
      state.bpm = v;
      bpmValue.textContent = String(v);
      lsSetSafe(lsKey, v);
      if (global.Tone && global.Tone.Transport) { try { global.Tone.Transport.bpm.value = v; } catch (_) {} }
      setActiveProgression(sec, v);
    });
    sec.querySelectorAll('.emo-bpm-step').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = parseInt(b.getAttribute('data-bpm'), 10);
        if (!clampBpm(v)) return;
        state.bpm = v;
        bpmInput.value = v;
        bpmValue.textContent = String(v);
        lsSetSafe(lsKey, v);
        if (global.Tone && global.Tone.Transport) { try { global.Tone.Transport.bpm.value = v; } catch (_) {} }
        setActiveProgression(sec, v);
      });
    });
  }
  function updateDensityMeter(steps, fillEl, valEl) {
    if (!steps) return;
    var total = 0, on = 0;
    ROWS.forEach(function (r) {
      var arr = steps[r] || [];
      for (var i = 0; i < arr.length; i++) { total++; if (arr[i] !== 'off') on++; }
    });
    var pct = total > 0 ? Math.round(on / total * 100) : 0;
    if (fillEl) fillEl.style.width = pct + '%';
    if (valEl) valEl.textContent = pct + '%';
  }
  function updateCrashBeatActive(sec, beatIdx) {
    sec.querySelectorAll('.emo-crash-beat').forEach(function (e) {
      var v = parseInt(e.getAttribute('data-beat'), 10);
      e.classList.toggle('is-current', v === beatIdx);
    });
  }
  // p5 ダブルキックビジュアライザ：BD 行 16 step を 2 ドットで密度可視化（連打=2 ドット点灯）
  function updateDoubleKickVisualizer(container, steps) {
    if (!container || !steps) return;
    var bd = steps['BD'] || [];
    container.querySelectorAll('.emo-dk-cell').forEach(function (cell) {
      var col = parseInt(cell.getAttribute('data-col'), 10);
      if (isNaN(col)) return;
      var s = bd[col] || 'off';
      cell.setAttribute('data-bd-state', s);
      // 2 連続埋まりかチェック（前後 step 含めて 16n 連打判定）
      var pair = (col % 2 === 0 ? bd[col + 1] : bd[col - 1]) || 'off';
      cell.classList.toggle('is-pair', s !== 'off' && pair !== 'off');
    });
  }
  function updateDoubleKickVisualizerActive(container, stepIdx) {
    if (!container) return;
    container.querySelectorAll('.emo-dk-cell.is-current').forEach(function (e) { e.classList.remove('is-current'); });
    var match = container.querySelector('.emo-dk-cell[data-col="' + stepIdx + '"]');
    if (match) match.classList.add('is-current');
  }
  // p5 kick_a/kick_b ラウンドロビン状態 lamp（dev-only）
  function flashKickPairLamp(container, key) {
    if (!container) return;
    var lamps = container.querySelectorAll('.emo-kick-pair-lamp');
    lamps.forEach(function (l) {
      var on = l.getAttribute('data-kick') === key;
      l.classList.toggle('is-fired', on);
    });
    // 100ms 後に消灯
    setTimeout(function () {
      lamps.forEach(function (l) { l.classList.remove('is-fired'); });
    }, 100);
  }

  // ---------------------------------------------------------
  // unmount API（pattern 単位）
  // ---------------------------------------------------------
  function unmount(rootEl) {
    if (!rootEl) return;
    leaveActiveBlock();
    rootEl.innerHTML = '';
  }

  // ---------------------------------------------------------
  // mount router（公開 API 本体）
  // ---------------------------------------------------------
  function mount(patternId, rootEl, opts) {
    if (!rootEl || !patternId) return null;
    if (rootEl.firstChild) return null; // 既にマウント済
    if (patternId === 'p1_six_stroke') return mountP1(patternId, rootEl, opts || {});
    if (patternId === 'p2_sizzle_hat_4steps') return mountP2(patternId, rootEl, opts || {});
    if (patternId === 'p3_halftime_shuffle') return mountP3(patternId, rootEl, opts || {});
    if (patternId === 'p4_4bar_fills')      return mountP4(patternId, rootEl, opts || {});
    if (patternId === 'p5_octopus')          return mountP5(patternId, rootEl, opts || {});
    if (patternId === 'p6_crash_quarter')    return mountP6(patternId, rootEl, opts || {});
    if (patternId === 'p7_ride_bell')        return mountP7(patternId, rootEl, opts || {});
    if (patternId === 'p8_subtractive')      return mountP8(patternId, rootEl, opts || {});
    return null;
  }

  // ---------------------------------------------------------
  // キーボードショートカット（B5/B6 実装（B6_p5/B6_p6 分岐含む）・spec.kbd_shortcut_disable_when 準拠）
  //   入力 focus 中（INPUT/TEXTAREA/SELECT/contenteditable/range）は全 disable
  //   - Space          : 開いているカードの play/pause
  //   - 1/2/3/4        : bar tab 切替（p2/p4 のみ）
  //   - Shift+1〜4     : step row 個別行クリア（HH/SD/BD/Cymbals）
  //   - Esc            : 現在 row のクリア → 何もなければ active block 停止
  //   - R              : 録音トグル（B10 実装後・現状 disabled なら no-op）
  //   - B              : BPM スライダーへ focus
  //   - ?              : ショートカットヘルプ表示
  //   ※ Shift+7 / Shift+8 は core.html 側のグローバルリスナーへ移動（IIFE 外）
  // ---------------------------------------------------------
  function isInputLikeFocused() {
    var t = document.activeElement;
    if (!t) return false;
    var tag = t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (t.isContentEditable) return true;
    return false;
  }
  function findOpenCardPlayBtn() {
    return document.querySelector('.phase1-pattern-card.open .emo-play-btn');
  }
  function findOpenCardSection() {
    return document.querySelector('.phase1-pattern-card.open .emo-lab-pattern');
  }
  function clearStepRow(sec, rowName) {
    if (!sec || !rowName) return false;
    var cells = sec.querySelectorAll('.emo-step[data-row="' + rowName + '"]');
    if (!cells.length) return false;
    // UX-17：clear 時も data-state を同期反映（spring transition で滑らかに OFF へ）
    cells.forEach(function (c) {
      c.setAttribute('data-state', 'off');
      c.dataset.state = 'off';
    });
    // 状態反映：state がパターンごとに違うため reset btn 経由ではなく DOM 直接 + dispatch
    sec.dispatchEvent(new CustomEvent('emo:row-clear', { detail: { row: rowName } }));
    return true;
  }
  document.addEventListener('keydown', function (ev) {
    if (isInputLikeFocused()) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return; // 修飾キー組合せは扱わない（Shift のみ許容）

    if (ev.key === ' ') {
      var activeBlock = global.__steady_active_block_id;
      var sel = '';
      if (activeBlock === 'B4') sel = '#emo-lab-p1 .emo-play-btn';
      else if (activeBlock === 'B5') sel = '#emo-lab-p2 .emo-play-btn';
      else if (activeBlock === 'B5_p3') sel = '#emo-lab-p3 .emo-play-btn';
      else if (activeBlock === 'B5_p4') sel = '#emo-lab-p4 .emo-play-btn';
      else if (activeBlock === 'B6_p5') sel = '#emo-lab-p5 .emo-play-btn';
      else if (activeBlock === 'B6_p6') sel = '#emo-lab-p6 .emo-play-btn';
      var btn = sel ? document.querySelector(sel) : null;
      if (!btn) btn = findOpenCardPlayBtn();
      if (btn) { ev.preventDefault(); btn.click(); }
      return;
    }
    if (ev.key === 'Escape') {
      // 開いているカードの section を取得し、最初の row（HH）から走査して 1 つでも off 以外があれば clear → 全 off なら block stop
      var sec = findOpenCardSection();
      if (sec) {
        var hasActive = !!sec.querySelector('.emo-step:not([data-state="off"])');
        if (hasActive) {
          ROWS.forEach(function (r) { clearStepRow(sec, r); });
          ev.preventDefault();
          return;
        }
      }
      leaveActiveBlock();
      ev.preventDefault();
      return;
    }
    // 数字 1〜4：bar tab（p2/p4）
    if (['1', '2', '3', '4'].indexOf(ev.key) !== -1 && !ev.shiftKey) {
      var sec2 = findOpenCardSection();
      if (sec2) {
        var bar = sec2.querySelector('.emo-bar-tab[data-bar="' + ev.key + '"]');
        if (bar) { ev.preventDefault(); bar.click(); return; }
      }
    }
    // Shift+1〜4：row クリア（1=HH / 2=SD / 3=BD / 4=Cymbals）
    if (ev.shiftKey && ['1', '2', '3', '4'].indexOf(ev.key) !== -1) {
      var rowMap = { '1': 'HH', '2': 'SD', '3': 'BD', '4': 'Cymbals' };
      var sec3 = findOpenCardSection();
      if (sec3 && clearStepRow(sec3, rowMap[ev.key])) {
        ev.preventDefault();
        return;
      }
    }
    // Shift+7 / Shift+8 は core.html 1st script 側でグローバル登録（IIFE 外）
    if (ev.key === 'B' || ev.key === 'b') {
      var bpmEl = document.querySelector('.phase1-pattern-card.open .emo-bpm-slider');
      if (bpmEl) { ev.preventDefault(); bpmEl.focus(); }
      return;
    }
    if (ev.key === 'R' || ev.key === 'r') {
      var rec = document.querySelector('.phase1-pattern-card.open .emo-record-btn');
      if (rec && !rec.disabled) { ev.preventDefault(); rec.click(); }
      return;
    }
    if (ev.key === '?') {
      ev.preventDefault();
      toggleKbdHelp();
      return;
    }
  });

  // step row clear → state 同期（mountP1/P3/P4 系：state.steps、mountP2 系：state.stepsByBar[currentBar-1]）
  // 実装は各 mount のクロージャ外なので、CustomEvent 'emo:row-clear' を購読して LS から再 init するアプローチを取る
  document.addEventListener('emo:row-clear', function (ev) {
    // pattern ごとに LS key が違うため、この generic ハンドラでは LS update を試みず DOM のみ反映済とする
    // クロージャ内 state はクリックで再描画される（次回 step click や play 再開時に DOM 値で再構築）
    // 完全な state 同期は Phase 2 の Helper API で対応予定
    void ev;
  });

  // ショートカットヘルプ（タップで開閉・aria-live 対応）
  // B7 MED-01 fix（Option A）：1〜4 行から「／ p8 では variation 切替（v1〜v4）」を削除（実装と整合）
  function toggleKbdHelp() {
    var existing = document.getElementById('emoKbdHelp');
    if (existing) {
      existing.parentNode.removeChild(existing);
      return;
    }
    var box = document.createElement('div');
    box.id = 'emoKbdHelp';
    box.className = 'emo-kbd-help';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'キーボードショートカット');
    box.innerHTML =
      '<div class="emo-kbd-help-card">' +
      '<h3>キーボードショートカット</h3>' +
      '<dl>' +
      '<dt>Space</dt><dd>再生 / 一時停止（p1〜p8 対応）</dd>' +
      '<dt>1〜4</dt><dd>バー切替（p2 / p4）</dd>' +
      '<dt>Shift+1〜4</dt><dd>HH / SD / BD / Cymbals 行をクリア（p5 含む Step Seq 全般）</dd>' +
      '<dt>Shift+7</dt><dd>p7 Ride Bell BPM 既定（120）に戻す</dd>' +
      '<dt>Shift+8</dt><dd>p8 Subtractive ローテモード切替（auto / manual）</dd>' +
      '<dt>Esc</dt><dd>編集をクリア → 停止</dd>' +
      '<dt>B</dt><dd>BPM スライダーへ移動</dd>' +
      '<dt>R</dt><dd>録音トグル（B10 実装後）</dd>' +
      '<dt>?</dt><dd>このヘルプを開閉</dd>' +
      '</dl>' +
      '<button type="button" class="btn-secondary" id="emoKbdHelpClose">閉じる</button>' +
      '</div>';
    document.body.appendChild(box);
    var close = document.getElementById('emoKbdHelpClose');
    if (close) close.addEventListener('click', toggleKbdHelp);
    box.addEventListener('click', function (ev) { if (ev.target === box) toggleKbdHelp(); });
  }

  // ---------------------------------------------------------
  // 公開 API（mount/unmount/toggleKbdHelp/version 上乗せ）
  //   loadMidiSpec / getPatternSpec / leaveActiveBlock は shared.js が登録済
  // ---------------------------------------------------------
  global.SteadyEmoLab.mount = mount;
  global.SteadyEmoLab.unmount = unmount;
  global.SteadyEmoLab.toggleKbdHelp = toggleKbdHelp;
  global.SteadyEmoLab.mountP5 = mountP5;
  global.SteadyEmoLab.mountP6 = mountP6;
  global.SteadyEmoLab.mountP7 = mountP7;
  global.SteadyEmoLab.mountP8 = mountP8;
  global.SteadyEmoLab.version = 'v3.2.0r2-block8';

  // V18 grep guard hookpoint — build 時の禁則パターン 0 件確認（list は別途グレップ表 GREP_GUARD_LIST.md 参照）
  //   1. age_exposure_terms（代表年齢関連語句）
  //   2. notation_glyphs（譜面記号類）
  //   3. console_log_traces（本番ログ残骸）
  //   4. optimism_bias_terms（楽観バイアス語）
  //   5. excluded_culture_terms_C1B（emo lab 領域内のみ・道場/修行記等の C1=B 除外集合）

  // 初期化（DOM ready 後）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadMidiSpec);
  } else {
    loadMidiSpec();
  }

  global.SteadyEmoLab._p5p8_loaded = true;
})(typeof window !== 'undefined' ? window : globalThis);
