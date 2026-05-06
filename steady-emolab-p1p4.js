/* =============================================================
   STEADY v3.2.0r2-block8 — SteadyEmoLab p1〜p4 module
   - core.html L1480-2759 抜粋（B8 Run 2 / T-04 module split）
   - p1 Six Stroke Roll / p2 Sizzle Hat 4段階 / p3 Half-time Shuffle / p4 4-bar fills
   - 共通 DOM helper も同居（p5p8.js が _helper 経由で参照）
   - 依存：steady-emolab-shared.js（先にロード必須）
   ============================================================= */

(function (global) {
  'use strict';

  // shared が未ロードなら早期 return（順序保護）
  if (!global.SteadyEmoLab || !global.SteadyEmoLab._shared_loaded) {
    if (global.STEADY_DEBUG) console.warn('[emolab] p1p4.js: shared module not loaded yet');
    return;
  }
  if (global.SteadyEmoLab._p1p4_loaded) return;

  var H = global.SteadyEmoLab._helper;
  // shared から helper を local 名で取り出し（コード本体を最小書換で運用）
  var loadMidiSpec        = H.loadMidiSpec;
  var getPatternSpec      = H.getPatternSpec;
  var clampBpm            = H.clampBpm;
  var leaveActiveBlock    = H.leaveActiveBlock;
  var lsGetSafe           = H.lsGetSafe;
  var lsSetSafe           = H.lsSetSafe;
  var lsBumpPhase1Progress = H.lsBumpPhase1Progress;
  var makeEmptySteps      = H.makeEmptySteps;
  var notesToSteps        = H.notesToSteps;
  var timeToStep          = H.timeToStep;
  var buildKitFor         = H.buildKitFor;
  var disposeKit          = H.disposeKit;
  var ROWS                = H.ROWS;
  var STATE_CYCLE         = H.STATE_CYCLE;
  var STATE_VELOCITY      = H.STATE_VELOCITY;

  // ---------------------------------------------------------
  // p1 Six Stroke Roll
  // ---------------------------------------------------------
  function mountP1(patternId, rootEl, opts) {
    var spec = getPatternSpec(patternId);
    if (!spec) {
      rootEl.innerHTML = '<p class="muted-text small">MIDI spec が読み込めませんでした。</p>';
      return null;
    }
    var BLOCK_ID = 'B4';
    var STAGE_ID = opts.patternStageId || 'sixstroke';
    var LS_KEYS = {
      bpm: 'steady_p1_six_stroke_bpm_v3_2',
      lastPlayed: 'steady_p1_six_stroke_lastPlayed_v3_2',
      steps: 'steady_p1_six_stroke_steps_v3_2'
    };
    var DEFAULT_BPM = 80;
    var bpm = clampBpm(lsGetSafe(LS_KEYS.bpm, DEFAULT_BPM)) || DEFAULT_BPM;
    var savedSteps = lsGetSafe(LS_KEYS.steps, null);
    var initialSteps = (savedSteps && typeof savedSteps === 'object') ? savedSteps : notesToSteps(spec.midi_notes);

    var sec = document.createElement('section');
    sec.className = 'emo-lab-pattern';
    sec.id = 'emo-lab-p1';
    sec.setAttribute('data-block', BLOCK_ID);
    sec.innerHTML = renderControlsHtml('p1', bpm, spec) +
      renderProgressionHtml('p1', spec.bpm_recommended_progression, bpm) +
      '<div class="emo-stick-indicator" id="stick-pattern-p1" aria-label="スティック手順 R-L 表示"></div>' +
      renderStepGridHtml('p1') +
      '<div class="emo-onomato" id="emo-onomato-p1" data-block="' + BLOCK_ID + '" data-pattern="' + patternId + '" aria-label="オノマトペ進行"></div>';
    rootEl.appendChild(sec);

    var bpmInput = sec.querySelector('.emo-bpm-slider');
    var bpmValue = sec.querySelector('.emo-bpm-value');
    var playBtn = sec.querySelector('.emo-play-btn');
    var recBtn = sec.querySelector('.emo-record-btn');
    var resetBtn = sec.querySelector('.emo-reset-btn');
    var grid = sec.querySelector('.emo-step-seq');
    var onomato = sec.querySelector('.emo-onomato');
    var stickInd = sec.querySelector('#stick-pattern-p1');

    bpmInput.value = bpm;
    bpmValue.textContent = String(bpm);
    var state = { steps: initialSteps, bpm: bpm, isPlaying: false, currentStep: -1, kit: null, repeatId: null, playStartedAt: 0, playElapsed: 0, cleanupBound: null };
    renderGrid(grid, state.steps);
    renderOnomato(onomato, spec.onomatopoeia_sync || []);
    renderStickIndicator(stickInd, spec.midi_notes || []);

    function persistSteps() { lsSetSafe(LS_KEYS.steps, state.steps); }

    // step click
    grid.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.emo-step');
      if (!btn) return;
      var row = btn.getAttribute('data-row');
      var col = parseInt(btn.getAttribute('data-col'), 10);
      if (!row || isNaN(col)) return;
      var cur = state.steps[row][col] || 'off';
      var idx = STATE_CYCLE.indexOf(cur);
      var next = STATE_CYCLE[(idx + 1) % STATE_CYCLE.length];
      state.steps[row][col] = next;
      // UX-17：data-state を同期実行（CSS spring transition で 1 frame 以内に visual 反映）
      btn.setAttribute('data-state', next);
      btn.dataset.state = next;
      persistSteps();
      // 再生中の場合は schedule 更新（簡易：cancel→build）
      if (state.isPlaying) rescheduleP1();
    });

    // BPM
    bpmInput.addEventListener('input', function () {
      var v = clampBpm(bpmInput.value);
      if (v == null) { bpmInput.value = state.bpm; return; }
      state.bpm = v;
      bpmValue.textContent = String(v);
      lsSetSafe(LS_KEYS.bpm, v);
      if (global.Tone && global.Tone.Transport) {
        try { global.Tone.Transport.bpm.value = v; } catch (_) {}
      }
      // progression active sync
      sec.querySelectorAll('.emo-bpm-step').forEach(function (b) {
        b.classList.toggle('active', parseInt(b.getAttribute('data-bpm'), 10) === v);
      });
    });

    // progression buttons
    sec.querySelectorAll('.emo-bpm-step').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = parseInt(b.getAttribute('data-bpm'), 10);
        if (!clampBpm(v)) return;
        state.bpm = v;
        bpmInput.value = v;
        bpmValue.textContent = String(v);
        lsSetSafe(LS_KEYS.bpm, v);
        if (global.Tone && global.Tone.Transport) {
          try { global.Tone.Transport.bpm.value = v; } catch (_) {}
        }
        sec.querySelectorAll('.emo-bpm-step').forEach(function (x) {
          x.classList.toggle('active', x === b);
        });
      });
    });

    // play/pause
    playBtn.addEventListener('click', function () {
      if (state.isPlaying) stopP1(); else startP1();
    });
    // reset (preset reload)
    resetBtn.addEventListener('click', function () {
      state.steps = notesToSteps(spec.midi_notes);
      persistSteps();
      renderGrid(grid, state.steps);
      if (state.isPlaying) rescheduleP1();
    });

    function startP1() {
      if (!global.Tone) { if (global.STEADY_DEBUG) console.warn('[emolab] Tone.js not loaded'); return; }
      // 排他制御
      if (global.__steady_active_block_id && global.__steady_active_block_id !== BLOCK_ID) {
        leaveActiveBlock();
      }
      global.__steady_active_block_id = BLOCK_ID;
      // start audio context (user gesture required)
      try {
        if (global.Tone.context && global.Tone.context.state !== 'running') {
          global.Tone.context.resume();
        }
        if (typeof global.Tone.start === 'function') global.Tone.start();
      } catch (_) {}
      state.kit = buildKitFor(patternId);
      if (!state.kit) return;
      try {
        global.Tone.Transport.cancel(0);
        global.Tone.Transport.bpm.value = state.bpm;
        global.Tone.Transport.loopEnd = '1m';
        global.Tone.Transport.loop = true;
      } catch (_) {}
      scheduleP1();
      try { global.Tone.Transport.start('+0.05'); } catch (_) {}
      state.isPlaying = true;
      state.playStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      state.playElapsed = 0;
      playBtn.textContent = '一時停止';
      playBtn.setAttribute('aria-pressed', 'true');
      lsSetSafe(LS_KEYS.lastPlayed, new Date().toISOString());
      // cleanup hook（block-leave 受信時に dispose）
      state.cleanupBound = function () { stopP1(); };
      document.addEventListener('steady:block-leave', state.cleanupBound, { once: true });
    }

    function rescheduleP1() {
      try { global.Tone.Transport.cancel(0); } catch (_) {}
      scheduleP1();
    }
    function scheduleP1() {
      if (!global.Tone || !state.kit) return;
      var stepIdx = -1;
      state.repeatId = global.Tone.Transport.scheduleRepeat(function (time) {
        stepIdx = (stepIdx + 1) % 16;
        var sxAt = stepIdx;
        // SD
        var sdState = state.steps['SD'][sxAt];
        if (sdState !== 'off' && state.kit.snare) {
          try { state.kit.snare.triggerAttackRelease('16n', time, STATE_VELOCITY[sdState]); } catch (_) {}
        }
        // BD
        var bdState = state.steps['BD'][sxAt];
        if (bdState !== 'off' && state.kit.kick) {
          try { state.kit.kick.triggerAttackRelease('C2', '8n', time, STATE_VELOCITY[bdState]); } catch (_) {}
        }
        // UI 更新（DOM 操作は draw 経由）
        global.Tone.Draw.schedule(function () {
          state.currentStep = sxAt;
          updateGridCurrent(grid, sxAt);
          updateOnomatoActive(onomato, sxAt);
          updateStickActive(stickInd, sxAt);
          // phase1_progress: 30 秒以上連続再生で +1 (max 100)
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
        // wobble capture (B11 で本実装・現状 no-op 契約)
        try {
          var ts = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          global.SteadyWobble.capture(BLOCK_ID, [ts], []);
        } catch (_) {}
      }, '16n', 0);
    }
    function stopP1() {
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
      state.isPlaying = false;
      state.currentStep = -1;
      playBtn.textContent = '再生';
      playBtn.setAttribute('aria-pressed', 'false');
      // UI
      grid.querySelectorAll('.emo-step.is-current').forEach(function (e) { e.classList.remove('is-current'); });
      onomato.querySelectorAll('span[data-active="true"]').forEach(function (e) { e.setAttribute('data-active', 'false'); });
      stickInd.querySelectorAll('.emo-stick.is-current').forEach(function (e) { e.classList.remove('is-current'); });
      if (state.cleanupBound) {
        document.removeEventListener('steady:block-leave', state.cleanupBound);
        state.cleanupBound = null;
      }
      if (global.__steady_active_block_id === BLOCK_ID) global.__steady_active_block_id = null;
    }

    return { stop: stopP1, dispose: stopP1 };
  }

  // ---------------------------------------------------------
  // p2 Sizzle Hat 4段階
  // ---------------------------------------------------------
  function mountP2(patternId, rootEl, opts) {
    var spec = getPatternSpec(patternId);
    if (!spec) {
      rootEl.innerHTML = '<p class="muted-text small">MIDI spec が読み込めませんでした。</p>';
      return null;
    }
    var BLOCK_ID = 'B5';
    var STAGE_ID = opts.patternStageId || 'sizzle_hat';
    var LS_KEYS = {
      bpm: 'steady_p2_sizzle_hat_bpm_v3_2',
      openness: 'steady_p2_sizzle_hat_openness_v3_2',
      lastPlayed: 'steady_p2_sizzle_hat_lastPlayed_v3_2',
      barTab: 'steady_p2_sizzle_hat_bar_v3_2',
      playedSet: 'steady_p2_sizzle_hat_played_set_v3_2',
      steps: 'steady_p2_sizzle_hat_steps_v3_2'
    };
    var DEFAULT_BPM = 100;
    var bpm = clampBpm(lsGetSafe(LS_KEYS.bpm, DEFAULT_BPM)) || DEFAULT_BPM;
    var openness = lsGetSafe(LS_KEYS.openness, 0);
    if (typeof openness !== 'number' || !Number.isFinite(openness) || openness < 0 || openness > 100) openness = 0;
    var currentBarTab = lsGetSafe(LS_KEYS.barTab, 1);
    if ([1, 2, 3, 4].indexOf(currentBarTab) === -1) currentBarTab = 1;

    var sec = document.createElement('section');
    sec.className = 'emo-lab-pattern';
    sec.id = 'emo-lab-p2';
    sec.setAttribute('data-block', BLOCK_ID);
    sec.innerHTML = renderControlsHtml('p2', bpm, spec) +
      renderProgressionHtml('p2', spec.bpm_recommended_progression, bpm) +
      '<div class="emo-bar-tabs" role="radiogroup" aria-label="バー選択（4 段階）">' +
        '<button type="button" class="emo-bar-tab" data-bar="1" role="radio">1</button>' +
        '<button type="button" class="emo-bar-tab" data-bar="2" role="radio">2</button>' +
        '<button type="button" class="emo-bar-tab" data-bar="3" role="radio">3</button>' +
        '<button type="button" class="emo-bar-tab" data-bar="4" role="radio">4</button>' +
      '</div>' +
      '<div class="emo-knob-row">' +
        '<canvas class="emo-knob-canvas" id="hat-knob-p2" role="slider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + openness + '" aria-label="ハイハット開閉度" tabindex="0"></canvas>' +
        '<div class="emo-knob-info">' +
          '<span class="emo-knob-label" id="hat-knob-label-p2">closed</span>' +
          '<span class="emo-knob-value" id="hat-knob-value-p2">開度 ' + openness + '%</span>' +
        '</div>' +
      '</div>' +
      '<div class="emo-openness-tabs" role="group" aria-label="開度プリセット">' +
        '<button type="button" class="emo-openness-tab" data-openness="0">0% 閉</button>' +
        '<button type="button" class="emo-openness-tab" data-openness="25">25%</button>' +
        '<button type="button" class="emo-openness-tab" data-openness="50">50%</button>' +
        '<button type="button" class="emo-openness-tab" data-openness="100">100% 開</button>' +
      '</div>' +
      renderStepGridHtml('p2') +
      '<canvas class="emo-beat-wheel" id="wheel-p2" aria-label="拍ホイール"></canvas>' +
      '<div class="emo-onomato" id="emo-onomato-p2" data-block="' + BLOCK_ID + '" data-pattern="' + patternId + '" aria-label="オノマトペ進行"></div>';
    rootEl.appendChild(sec);

    var bpmInput = sec.querySelector('.emo-bpm-slider');
    var bpmValue = sec.querySelector('.emo-bpm-value');
    var playBtn = sec.querySelector('.emo-play-btn');
    var resetBtn = sec.querySelector('.emo-reset-btn');
    var knob = sec.querySelector('#hat-knob-p2');
    var knobLabel = sec.querySelector('#hat-knob-label-p2');
    var knobValue = sec.querySelector('#hat-knob-value-p2');
    var grid = sec.querySelector('.emo-step-seq');
    var wheel = sec.querySelector('#wheel-p2');
    var onomato = sec.querySelector('.emo-onomato');

    bpmInput.value = bpm;
    bpmValue.textContent = String(bpm);

    // steps 永続化（B4 MED #1 関連：spec ベースで初期化、保存値があれば優先）
    var savedStepsByBar = lsGetSafe(LS_KEYS.steps, null);
    var initialStepsByBar = (Array.isArray(savedStepsByBar) && savedStepsByBar.length === 4)
      ? savedStepsByBar : buildStepsByBarFromSpec(spec);
    var state = {
      bpm: bpm,
      openness: openness,
      currentBar: currentBarTab,
      isPlaying: false,
      kit: null,
      currentStep: -1,
      currentBeat: -1,
      stepsByBar: initialStepsByBar,
      cleanupBound: null,
      resizeObs: null,
      playStartedAt: 0,
      playElapsed: 0,
      playedVariations: lsGetSafe(LS_KEYS.playedSet, { 1: 0, 2: 0, 3: 0, 4: 0 }),
      repeatId: null
    };
    renderGrid(grid, state.stepsByBar[state.currentBar - 1] || makeEmptySteps());
    renderOnomatoForP2(onomato, spec, state.currentBar);
    setActiveBarTab(sec, state.currentBar);
    setActiveOpennessTab(sec, opennessToStep(state.openness));
    drawKnob(knob, state.openness);
    knobLabel.textContent = opennessToLabel(state.openness, spec);
    knobValue.textContent = '開度 ' + state.openness + '%';
    drawWheel();

    // ResizeObserver — Beat Wheel
    if (global.ResizeObserver) {
      state.resizeObs = new global.ResizeObserver(function () { drawWheel(); });
      state.resizeObs.observe(wheel);
    }
    function drawWheel() {
      global.SteadyBeatWheel.render(wheel, { beats: 4, currentBeat: state.currentBeat });
    }
    // B4 MED #4：未 play のままブロック離脱時も ResizeObserver を disconnect
    var idleCleanupBound = function () {
      if (state.resizeObs) {
        try { state.resizeObs.disconnect(); } catch (_) {}
        state.resizeObs = null;
      }
    };
    document.addEventListener('steady:block-leave', idleCleanupBound);

    // bpm slider
    bpmInput.addEventListener('input', function () {
      var v = clampBpm(bpmInput.value);
      if (v == null) { bpmInput.value = state.bpm; return; }
      state.bpm = v;
      bpmValue.textContent = String(v);
      lsSetSafe(LS_KEYS.bpm, v);
      if (global.Tone && global.Tone.Transport) {
        try { global.Tone.Transport.bpm.value = v; } catch (_) {}
      }
    });
    sec.querySelectorAll('.emo-bpm-step').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = parseInt(b.getAttribute('data-bpm'), 10);
        if (!clampBpm(v)) return;
        state.bpm = v;
        bpmInput.value = v;
        bpmValue.textContent = String(v);
        lsSetSafe(LS_KEYS.bpm, v);
        if (global.Tone && global.Tone.Transport) {
          try { global.Tone.Transport.bpm.value = v; } catch (_) {}
        }
        sec.querySelectorAll('.emo-bpm-step').forEach(function (x) {
          x.classList.toggle('active', x === b);
        });
      });
    });
    // bar tabs
    sec.querySelectorAll('.emo-bar-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        var bar = parseInt(b.getAttribute('data-bar'), 10);
        if ([1, 2, 3, 4].indexOf(bar) === -1) return;
        state.currentBar = bar;
        lsSetSafe(LS_KEYS.barTab, bar);
        setActiveBarTab(sec, bar);
        // openness を自動同期：bar に対応する variation の openness をセット
        var variation = (spec.variations && spec.variations[bar - 1]) || null;
        if (variation && typeof variation.openness === 'number') {
          state.openness = variation.openness;
          lsSetSafe(LS_KEYS.openness, state.openness);
          drawKnob(knob, state.openness);
          knob.setAttribute('aria-valuenow', String(state.openness));
          knobLabel.textContent = opennessToLabel(state.openness, spec);
          knobValue.textContent = '開度 ' + state.openness + '%';
          setActiveOpennessTab(sec, opennessToStep(state.openness));
        }
        renderGrid(grid, state.stepsByBar[bar - 1] || makeEmptySteps());
        renderOnomatoForP2(onomato, spec, bar);
        if (state.kit && state.kit.hihat) {
          var dec = (variation && typeof variation.decay === 'number') ? variation.decay : 0.05;
          try { state.kit.hihat.envelope.decay = dec; } catch (_) {}
        }
      });
    });
    // openness tab
    sec.querySelectorAll('.emo-openness-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = parseInt(b.getAttribute('data-openness'), 10);
        if (!Number.isFinite(v)) return;
        state.openness = v;
        lsSetSafe(LS_KEYS.openness, v);
        drawKnob(knob, v);
        knob.setAttribute('aria-valuenow', String(v));
        knobLabel.textContent = opennessToLabel(v, spec);
        knobValue.textContent = '開度 ' + v + '%';
        setActiveOpennessTab(sec, opennessToStep(v));
        // synth decay 動的書換
        var variation = opennessToVariation(v, spec);
        if (state.kit && state.kit.hihat && variation) {
          try { state.kit.hihat.envelope.decay = variation.decay; } catch (_) {}
        }
      });
    });
    // knob keyboard support
    knob.addEventListener('keydown', function (ev) {
      var step = 25;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') { snapOpenness(state.openness + step); ev.preventDefault(); }
      if (ev.key === 'ArrowLeft'  || ev.key === 'ArrowDown') { snapOpenness(state.openness - step); ev.preventDefault(); }
    });
    // knob drag (pointer) — B4 MED #3：pointermove 中の lsSet を回避し、pointerup で 1 回だけ persist
    knob.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      try { knob.setPointerCapture(ev.pointerId); } catch (_) {}
      function pointerMove(e2) {
        var rect = knob.getBoundingClientRect();
        var cx = rect.left + rect.width / 2;
        var cy = rect.top + rect.height / 2;
        var dx = e2.clientX - cx;
        var dy = e2.clientY - cy;
        var ang = Math.atan2(dy, dx); // -PI..PI
        // 12時=−PI/2 を 0、時計回りに 0..100
        var deg = ang * 180 / Math.PI + 90;
        if (deg < 0) deg += 360;
        var pct = Math.round(deg / 360 * 100);
        snapOpenness(pct, true); // skipPersist=true：drag 中は LS 書込みしない
      }
      function pointerUp() {
        knob.removeEventListener('pointermove', pointerMove);
        knob.removeEventListener('pointerup', pointerUp);
        knob.removeEventListener('pointercancel', pointerUp);
        // drag 終了時に 1 回だけ persist
        try { lsSetSafe(LS_KEYS.openness, state.openness); } catch (_) {}
      }
      knob.addEventListener('pointermove', pointerMove);
      knob.addEventListener('pointerup', pointerUp);
      knob.addEventListener('pointercancel', pointerUp);
    });
    function snapOpenness(raw, skipPersist) {
      var v = raw;
      if (!Number.isFinite(v)) return;
      // 4 段階スナップ（0/25/50/100）
      var levels = [0, 25, 50, 100];
      var best = levels.reduce(function (a, b) { return Math.abs(b - v) < Math.abs(a - v) ? b : a; }, levels[0]);
      // 値が同じなら早期 return（無駄 paint / lsSet 防止・B4 MED #3）
      if (state.openness === best && skipPersist) return;
      state.openness = best;
      if (!skipPersist) lsSetSafe(LS_KEYS.openness, best);
      drawKnob(knob, best);
      knob.setAttribute('aria-valuenow', String(best));
      knobLabel.textContent = opennessToLabel(best, spec);
      knobValue.textContent = '開度 ' + best + '%';
      setActiveOpennessTab(sec, opennessToStep(best));
      var variation = opennessToVariation(best, spec);
      if (state.kit && state.kit.hihat && variation) {
        try { state.kit.hihat.envelope.decay = variation.decay; } catch (_) {}
      }
    }

    // step click — B4 MED #1：currentBar 動的参照 + persist
    grid.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.emo-step');
      if (!btn) return;
      var row = btn.getAttribute('data-row');
      var col = parseInt(btn.getAttribute('data-col'), 10);
      if (!row || isNaN(col)) return;
      var bar = state.currentBar - 1; // クリック時点の currentBar を即評価
      if (!state.stepsByBar[bar]) state.stepsByBar[bar] = makeEmptySteps();
      if (!state.stepsByBar[bar][row]) return;
      var cur = state.stepsByBar[bar][row][col] || 'off';
      var idx = STATE_CYCLE.indexOf(cur);
      var next = STATE_CYCLE[(idx + 1) % STATE_CYCLE.length];
      state.stepsByBar[bar][row][col] = next;
      // UX-17：data-state を同期実行（CSS spring transition で 1 frame 以内に visual 反映）
      btn.setAttribute('data-state', next);
      btn.dataset.state = next;
      // 永続化（編集を再生で消さない・Reload 後も保持）
      try { lsSetSafe(LS_KEYS.steps, state.stepsByBar); } catch (_) {}
    });

    // play/pause
    playBtn.addEventListener('click', function () { if (state.isPlaying) stopP2(); else startP2(); });
    resetBtn.addEventListener('click', function () {
      state.stepsByBar = buildStepsByBarFromSpec(spec);
      renderGrid(grid, state.stepsByBar[state.currentBar - 1] || makeEmptySteps());
      // 編集 reset を永続化（B4 MED #1 完成形）
      try { lsSetSafe(LS_KEYS.steps, state.stepsByBar); } catch (_) {}
    });

    function startP2() {
      if (!global.Tone) { if (global.STEADY_DEBUG) console.warn('[emolab] Tone.js not loaded'); return; }
      if (global.__steady_active_block_id && global.__steady_active_block_id !== BLOCK_ID) {
        leaveActiveBlock();
      }
      global.__steady_active_block_id = BLOCK_ID;
      try {
        if (global.Tone.context && global.Tone.context.state !== 'running') global.Tone.context.resume();
        if (typeof global.Tone.start === 'function') global.Tone.start();
      } catch (_) {}
      state.kit = buildKitFor(patternId);
      if (!state.kit) return;
      // initial decay
      var variation = opennessToVariation(state.openness, spec);
      if (state.kit.hihat && variation) {
        try { state.kit.hihat.envelope.decay = variation.decay; } catch (_) {}
      }
      try {
        global.Tone.Transport.cancel(0);
        global.Tone.Transport.bpm.value = state.bpm;
        global.Tone.Transport.loopEnd = '4m';
        global.Tone.Transport.loop = true;
      } catch (_) {}
      scheduleP2();
      try { global.Tone.Transport.start('+0.05'); } catch (_) {}
      state.isPlaying = true;
      state.playStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      state.playElapsed = 0;
      playBtn.textContent = '一時停止';
      playBtn.setAttribute('aria-pressed', 'true');
      lsSetSafe(LS_KEYS.lastPlayed, new Date().toISOString());
      state.cleanupBound = function () { stopP2(); };
      document.addEventListener('steady:block-leave', state.cleanupBound, { once: true });
    }
    function scheduleP2() {
      if (!global.Tone || !state.kit) return;
      // 4 拍 × 4 小節 = 16 step（8n 単位で 1 小節 8 step・4 小節で 32 step だが 8 step ループ × 4 small bars 表示）
      // ここでは Tone.Transport.position から bar/step を割り出して groove_per_bar を再生
      var stepIdx = -1;
      // B4 MED #2：repeatId を保持して stop 時に確実 cancel
      state.repeatId = global.Tone.Transport.scheduleRepeat(function (time) {
        stepIdx = (stepIdx + 1) % 32; // 4 bar × 8 step (8n)
        var barIdx = Math.floor(stepIdx / 8); // 0..3
        var stepInBar = stepIdx % 8;
        var beat = Math.floor(stepInBar / 2); // 0..3
        var variation = (spec.variations && spec.variations[barIdx]) || spec.variations[0];
        // groove: BD on beats 1,3 / SD on 2,4 / HH on every beat
        var velocityBd = (beat === 0 || beat === 2) && stepInBar % 2 === 0 ? 0.85 : 0;
        var velocitySd = (beat === 1 || beat === 3) && stepInBar % 2 === 0 ? 0.9  : 0;
        var velocityHh = (stepInBar % 2 === 0) ? 0.7 : 0;
        if (velocityBd > 0 && state.kit.kick) {
          try { state.kit.kick.triggerAttackRelease('C2', '8n', time, velocityBd); } catch (_) {}
        }
        if (velocitySd > 0 && state.kit.snare) {
          try { state.kit.snare.triggerAttackRelease('8n', time, velocitySd); } catch (_) {}
        }
        if (velocityHh > 0 && state.kit.hihat) {
          // openness/variation に応じて decay 動的書換
          if (variation && typeof variation.decay === 'number') {
            try { state.kit.hihat.envelope.decay = variation.decay; } catch (_) {}
          }
          var noteName = (variation && variation.note) || 'F#2';
          try { state.kit.hihat.triggerAttackRelease(noteName, '16n', time, velocityHh); } catch (_) {}
        }
        // playedVariations 蓄積
        if (state.playedVariations) {
          state.playedVariations[barIdx + 1] = (state.playedVariations[barIdx + 1] || 0) + 1;
        }
        global.Tone.Draw.schedule(function () {
          state.currentStep = stepInBar;
          state.currentBeat = beat;
          if (barIdx + 1 === state.currentBar) {
            updateGridCurrent(grid, stepInBar * 2); // 8th step を 16 グリッドの偶数列にマップ
            updateOnomatoActive(onomato, beat);
          }
          drawWheel();
          // Phase 1 progress: 4 段階全部一度ずつ再生（30 秒以上）で +10 (max 100)
          if (state.playStartedAt > 0) {
            var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            var elapsed = now - state.playStartedAt;
            if (elapsed >= 30000 && state.playElapsed < 30000) {
              var allPlayed = [1, 2, 3, 4].every(function (k) { return (state.playedVariations[k] || 0) > 0; });
              if (allPlayed) {
                lsBumpPhase1Progress(STAGE_ID, 10, 100);
                lsSetSafe(LS_KEYS.playedSet, state.playedVariations);
                if (typeof opts.onProgressTick === 'function') opts.onProgressTick();
              }
            }
            state.playElapsed = elapsed;
          }
        }, time);
        try {
          var ts = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          global.SteadyWobble.capture(BLOCK_ID, [ts], []);
        } catch (_) {}
      }, '8n', 0);
    }
    function stopP2() {
      try {
        if (global.Tone && global.Tone.Transport) {
          global.Tone.Transport.stop();
          // B4 MED #2：repeatId 単位で確実 cancel（cancel(0) と併用）
          if (state.repeatId !== null && state.repeatId !== undefined) {
            try { global.Tone.Transport.clear(state.repeatId); } catch (_) {}
            state.repeatId = null;
          }
          global.Tone.Transport.cancel(0);
        }
      } catch (_) {}
      disposeKit(state.kit);
      state.kit = null;
      state.isPlaying = false;
      state.currentStep = -1;
      state.currentBeat = -1;
      playBtn.textContent = '再生';
      playBtn.setAttribute('aria-pressed', 'false');
      grid.querySelectorAll('.emo-step.is-current').forEach(function (e) { e.classList.remove('is-current'); });
      onomato.querySelectorAll('span[data-active="true"]').forEach(function (e) { e.setAttribute('data-active', 'false'); });
      drawWheel();
      lsSetSafe(LS_KEYS.playedSet, state.playedVariations || {});
      if (state.cleanupBound) {
        document.removeEventListener('steady:block-leave', state.cleanupBound);
        state.cleanupBound = null;
      }
      if (state.resizeObs) {
        try { state.resizeObs.disconnect(); } catch (_) {}
        state.resizeObs = null;
      }
      if (global.__steady_active_block_id === BLOCK_ID) global.__steady_active_block_id = null;
    }

    return { stop: stopP2, dispose: stopP2 };
  }

  // ---------------------------------------------------------
  // p3 Half-time Shuffle（B5）
  //   - swing=0.58（block-leave で 0 に戻す・他 block への副作用回避）
  //   - BPM rotation 70/100/120
  //   - feel toggle (shuffle / straight)
  //   - halftime indicator（常時表示・OFF 不可：本パターンの本質）
  //   - onomatopoeia ドッ ティ タッ ティ
  // ---------------------------------------------------------
  function mountP3(patternId, rootEl, opts) {
    var spec = getPatternSpec(patternId);
    if (!spec) {
      rootEl.innerHTML = '<p class="muted-text small">MIDI spec が読み込めませんでした。</p>';
      return null;
    }
    var BLOCK_ID = 'B5_p3'; // master B5 内パターン識別（spec B6 相当）
    var STAGE_ID = opts.patternStageId || 'halftime';
    var LS_KEYS = {
      bpm:        'steady_p3_halftime_bpm_v3_2',
      lastPlayed: 'steady_p3_halftime_lastPlayed_v3_2',
      steps:      'steady_p3_halftime_steps_v3_2',
      feel:       'steady_p3_halftime_feel_v3_2'
    };
    var DEFAULT_BPM = 100;
    var bpm = clampBpm(lsGetSafe(LS_KEYS.bpm, DEFAULT_BPM)) || DEFAULT_BPM;
    var feel = lsGetSafe(LS_KEYS.feel, 'shuffle');
    if (feel !== 'shuffle' && feel !== 'straight') feel = 'shuffle';
    var savedSteps = lsGetSafe(LS_KEYS.steps, null);
    // shape validation：4 行（HH/SD/BD/Cymbals）× 16 step を満たさなければ spec から再生成
    var validShape = !!(savedSteps && typeof savedSteps === 'object' &&
      ROWS.every(function (r) { return Array.isArray(savedSteps[r]) && savedSteps[r].length === 16; }));
    var initialSteps = validShape ? savedSteps : notesToSteps(spec.midi_notes);

    var sec = document.createElement('section');
    sec.className = 'emo-lab-pattern';
    sec.id = 'emo-lab-p3';
    sec.setAttribute('data-block', BLOCK_ID);
    sec.innerHTML = renderControlsHtml('p3', bpm, spec) +
      renderProgressionHtml('p3', spec.bpm_recommended_progression, bpm) +
      '<div class="emo-feel-row" role="group" aria-label="フィール切替">' +
        '<span class="emo-halftime-indicator" aria-label="Half-time（バックビート 1/2 倍速）" title="Half-time：SD を 3 拍目に置く奏法">Half-time</span>' +
        '<button type="button" class="emo-feel-btn" data-feel="shuffle"' + (feel === 'shuffle' ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>シャッフル</button>' +
        '<button type="button" class="emo-feel-btn" data-feel="straight"' + (feel === 'straight' ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>ストレート</button>' +
      '</div>' +
      renderStepGridHtml('p3') +
      '<div class="emo-onomato" id="emo-onomato-p3" data-block="' + BLOCK_ID + '" data-pattern="' + patternId + '" aria-label="オノマトペ進行"></div>';
    rootEl.appendChild(sec);

    var bpmInput = sec.querySelector('.emo-bpm-slider');
    var bpmValue = sec.querySelector('.emo-bpm-value');
    var playBtn = sec.querySelector('.emo-play-btn');
    var resetBtn = sec.querySelector('.emo-reset-btn');
    var grid = sec.querySelector('.emo-step-seq');
    var onomato = sec.querySelector('.emo-onomato');

    bpmInput.value = bpm;
    bpmValue.textContent = String(bpm);

    var state = {
      bpm: bpm,
      feel: feel,
      steps: initialSteps,
      isPlaying: false,
      currentStep: -1,
      kit: null,
      repeatId: null,
      cleanupBound: null,
      playStartedAt: 0,
      playElapsed: 0
    };
    renderGrid(grid, state.steps);
    renderOnomato(onomato, spec.onomatopoeia_sync || []);
    setActiveProgression(sec, bpm);

    function persistSteps() { try { lsSetSafe(LS_KEYS.steps, state.steps); } catch (_) {} }

    // step click（B4 MED #1 同方針：dynamic 参照 + persist）
    grid.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.emo-step');
      if (!btn) return;
      var row = btn.getAttribute('data-row');
      var col = parseInt(btn.getAttribute('data-col'), 10);
      if (!row || isNaN(col)) return;
      if (!state.steps[row]) return;
      var cur = state.steps[row][col] || 'off';
      var idx = STATE_CYCLE.indexOf(cur);
      var next = STATE_CYCLE[(idx + 1) % STATE_CYCLE.length];
      state.steps[row][col] = next;
      // UX-17：data-state を同期実行（CSS spring transition で 1 frame 以内に visual 反映）
      btn.setAttribute('data-state', next);
      btn.dataset.state = next;
      persistSteps();
      if (state.isPlaying) reschedule();
    });

    // BPM
    bpmInput.addEventListener('input', function () {
      var v = clampBpm(bpmInput.value);
      if (v == null) { bpmInput.value = state.bpm; return; }
      state.bpm = v;
      bpmValue.textContent = String(v);
      lsSetSafe(LS_KEYS.bpm, v);
      if (global.Tone && global.Tone.Transport) {
        try { global.Tone.Transport.bpm.value = v; } catch (_) {}
      }
      setActiveProgression(sec, v);
    });
    sec.querySelectorAll('.emo-bpm-step').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = parseInt(b.getAttribute('data-bpm'), 10);
        if (!clampBpm(v)) return;
        state.bpm = v;
        bpmInput.value = v;
        bpmValue.textContent = String(v);
        lsSetSafe(LS_KEYS.bpm, v);
        if (global.Tone && global.Tone.Transport) {
          try { global.Tone.Transport.bpm.value = v; } catch (_) {}
        }
        setActiveProgression(sec, v);
      });
    });

    // feel toggle（shuffle / straight）
    sec.querySelectorAll('.emo-feel-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var next = b.getAttribute('data-feel');
        if (next !== 'shuffle' && next !== 'straight') return;
        state.feel = next;
        lsSetSafe(LS_KEYS.feel, next);
        sec.querySelectorAll('.emo-feel-btn').forEach(function (x) {
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        // 再生中なら swing 値を即時切替
        applySwing();
      });
    });

    function applySwing() {
      if (!global.Tone || !global.Tone.Transport) return;
      try {
        if (state.feel === 'shuffle') {
          global.Tone.Transport.swing = 0.58;
          global.Tone.Transport.swingSubdivision = '8n';
        } else {
          global.Tone.Transport.swing = 0;
        }
      } catch (_) {}
    }

    playBtn.addEventListener('click', function () { if (state.isPlaying) stopP3(); else startP3(); });
    resetBtn.addEventListener('click', function () {
      state.steps = notesToSteps(spec.midi_notes);
      renderGrid(grid, state.steps);
      persistSteps();
      if (state.isPlaying) reschedule();
    });

    function startP3() {
      if (!global.Tone) { if (global.STEADY_DEBUG) console.warn('[emolab] Tone.js not loaded'); return; }
      if (global.__steady_active_block_id && global.__steady_active_block_id !== BLOCK_ID) {
        leaveActiveBlock();
      }
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
        applySwing();
      } catch (_) {}
      schedule();
      try { global.Tone.Transport.start('+0.05'); } catch (_) {}
      state.isPlaying = true;
      state.playStartedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      state.playElapsed = 0;
      playBtn.textContent = '一時停止';
      playBtn.setAttribute('aria-pressed', 'true');
      lsSetSafe(LS_KEYS.lastPlayed, new Date().toISOString());
      state.cleanupBound = function () { stopP3(); };
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
        if (bdState !== 'off' && state.kit.kick) {
          try { state.kit.kick.triggerAttackRelease('C2', '8n', time, STATE_VELOCITY[bdState]); } catch (_) {}
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
          // onomato は 4 拍位置のみアクティブ表示（spec onomatopoeia_sync が 4 拍）
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

    function stopP3() {
      try {
        if (global.Tone && global.Tone.Transport) {
          global.Tone.Transport.stop();
          if (state.repeatId !== null && state.repeatId !== undefined) {
            try { global.Tone.Transport.clear(state.repeatId); } catch (_) {}
            state.repeatId = null;
          }
          global.Tone.Transport.cancel(0);
          // swing を 0 へリセット（他 block への副作用回避・p3 仕様）
          try { global.Tone.Transport.swing = 0; } catch (_) {}
        }
      } catch (_) {}
      disposeKit(state.kit);
      state.kit = null;
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

    return { stop: stopP3, dispose: stopP3 };
  }

  // ---------------------------------------------------------
  // p4 4-bar fills（B5）
  //   - 3 小節 groove + 4 小節目 fill
  //   - fill rotation: manual / sequential / random
  //   - bar tabs 1/2/3/4（4 のみ fill 種別 selector が活性）
  //   - groove transition indicator（再生中 1〜3 / 4 を可視化）
  //   - fill SVG visualizer（記譜記号は使わない・抽象アイコン）
  //   - crash dispose は disposeKit 経由（1600ms 待機）
  // ---------------------------------------------------------
  function mountP4(patternId, rootEl, opts) {
    var spec = getPatternSpec(patternId);
    if (!spec) {
      rootEl.innerHTML = '<p class="muted-text small">MIDI spec が読み込めませんでした。</p>';
      return null;
    }
    var BLOCK_ID = 'B5_p4'; // master B5 内パターン識別（spec B7 相当）
    var STAGE_ID = opts.patternStageId || 'fourbar_fills';
    var LS_KEYS = {
      bpm:        'steady_p4_4bar_fills_bpm_v3_2',
      lastPlayed: 'steady_p4_4bar_fills_lastPlayed_v3_2',
      currentFill:'steady_p4_4bar_fills_current_v3_2',
      mode:       'steady_p4_4bar_fills_mode_v3_2',
      bar:        'steady_p4_4bar_fills_bar_v3_2'
    };
    var DEFAULT_BPM = 120;
    var bpm = clampBpm(lsGetSafe(LS_KEYS.bpm, DEFAULT_BPM)) || DEFAULT_BPM;
    var fillTypes = spec.fill_types || [];
    var currentFill = lsGetSafe(LS_KEYS.currentFill, 'f1');
    if (!fillTypes.some(function (f) { return f.id === currentFill; })) currentFill = 'f1';
    var rotationMode = lsGetSafe(LS_KEYS.mode, 'manual');
    if (['manual', 'sequential', 'random'].indexOf(rotationMode) === -1) rotationMode = 'manual';
    var currentBar = lsGetSafe(LS_KEYS.bar, 1);
    if ([1, 2, 3, 4].indexOf(currentBar) === -1) currentBar = 1;

    var sec = document.createElement('section');
    sec.className = 'emo-lab-pattern';
    sec.id = 'emo-lab-p4';
    sec.setAttribute('data-block', BLOCK_ID);

    var fillOptionsHtml = fillTypes.map(function (f) {
      return '<option value="' + f.id + '"' + (f.id === currentFill ? ' selected' : '') + '>' + f.id.toUpperCase() + '：' + f.name + '</option>';
    }).join('');

    sec.innerHTML = renderControlsHtml('p4', bpm, spec) +
      renderProgressionHtml('p4', spec.bpm_recommended_progression, bpm) +
      '<div class="emo-fill-rotation-row">' +
        '<div class="emo-fill-rotation-selector" role="group" aria-label="フィル ローテモード">' +
          '<button type="button" class="emo-rotation-btn" data-mode="manual"' + (rotationMode === 'manual' ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>手動</button>' +
          '<button type="button" class="emo-rotation-btn" data-mode="sequential"' + (rotationMode === 'sequential' ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>順番</button>' +
          '<button type="button" class="emo-rotation-btn" data-mode="random"' + (rotationMode === 'random' ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>ランダム</button>' +
        '</div>' +
        '<label class="emo-fill-select-label" for="p4-fill-select">フィル種類</label>' +
        '<select id="p4-fill-select" class="emo-fill-select" aria-label="4 小節目フィル種類">' + fillOptionsHtml + '</select>' +
      '</div>' +
      '<div class="emo-bar-tabs" role="radiogroup" aria-label="バー選択（1〜3 = グルーヴ / 4 = フィル）">' +
        '<button type="button" class="emo-bar-tab" data-bar="1" role="radio">1</button>' +
        '<button type="button" class="emo-bar-tab" data-bar="2" role="radio">2</button>' +
        '<button type="button" class="emo-bar-tab" data-bar="3" role="radio">3</button>' +
        '<button type="button" class="emo-bar-tab" data-bar="4" role="radio">4 フィル</button>' +
      '</div>' +
      '<div class="emo-groove-transition" aria-label="グルーヴ → フィル 進行表示">' +
        '<span class="emo-groove-cell" data-bar="1">1</span>' +
        '<span class="emo-groove-cell" data-bar="2">2</span>' +
        '<span class="emo-groove-cell" data-bar="3">3</span>' +
        '<span class="emo-groove-cell is-fill" data-bar="4">4</span>' +
      '</div>' +
      '<div class="emo-fill-visualizer" id="emo-fill-visualizer-p4" aria-label="フィル形状（抽象表示・記譜記号なし）"></div>' +
      '<div class="emo-onomato" id="emo-onomato-p4" data-block="' + BLOCK_ID + '" data-pattern="' + patternId + '" aria-label="オノマトペ進行"></div>';
    rootEl.appendChild(sec);

    var bpmInput = sec.querySelector('.emo-bpm-slider');
    var bpmValue = sec.querySelector('.emo-bpm-value');
    var playBtn = sec.querySelector('.emo-play-btn');
    var resetBtn = sec.querySelector('.emo-reset-btn');
    var fillSelect = sec.querySelector('#p4-fill-select');
    var fillVisual = sec.querySelector('#emo-fill-visualizer-p4');
    var onomato = sec.querySelector('.emo-onomato');

    bpmInput.value = bpm;
    bpmValue.textContent = String(bpm);
    setActiveProgression(sec, bpm);
    setActiveBarTab(sec, currentBar);
    setActiveFillSelectability(sec, currentBar);

    var state = {
      bpm: bpm,
      currentFill: currentFill,
      rotationMode: rotationMode,
      currentBar: currentBar,
      isPlaying: false,
      kit: null,
      repeatId: null,
      cleanupBound: null,
      playStartedAt: 0,
      playElapsed: 0,
      activeBarIdx: 0, // 再生中の現在小節 (0-3)
      fillsPlayed: 0   // 累積フィル回数（progress 用）
    };

    renderFillVisualizer(fillVisual, currentFill, fillTypes);
    renderOnomatoForP4(onomato, currentBar, fillTypes, currentFill);

    // BPM
    bpmInput.addEventListener('input', function () {
      var v = clampBpm(bpmInput.value);
      if (v == null) { bpmInput.value = state.bpm; return; }
      state.bpm = v;
      bpmValue.textContent = String(v);
      lsSetSafe(LS_KEYS.bpm, v);
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
        lsSetSafe(LS_KEYS.bpm, v);
        if (global.Tone && global.Tone.Transport) { try { global.Tone.Transport.bpm.value = v; } catch (_) {} }
        setActiveProgression(sec, v);
      });
    });

    // bar tabs
    sec.querySelectorAll('.emo-bar-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        var bar = parseInt(b.getAttribute('data-bar'), 10);
        if ([1, 2, 3, 4].indexOf(bar) === -1) return;
        state.currentBar = bar;
        lsSetSafe(LS_KEYS.bar, bar);
        setActiveBarTab(sec, bar);
        setActiveFillSelectability(sec, bar);
        renderOnomatoForP4(onomato, bar, fillTypes, state.currentFill);
      });
    });

    // rotation mode
    sec.querySelectorAll('.emo-rotation-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = b.getAttribute('data-mode');
        if (['manual', 'sequential', 'random'].indexOf(m) === -1) return;
        state.rotationMode = m;
        lsSetSafe(LS_KEYS.mode, m);
        sec.querySelectorAll('.emo-rotation-btn').forEach(function (x) {
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
      });
    });

    // fill select
    fillSelect.addEventListener('change', function () {
      state.currentFill = fillSelect.value;
      lsSetSafe(LS_KEYS.currentFill, state.currentFill);
      renderFillVisualizer(fillVisual, state.currentFill, fillTypes);
      renderOnomatoForP4(onomato, state.currentBar, fillTypes, state.currentFill);
    });

    playBtn.addEventListener('click', function () { if (state.isPlaying) stopP4(); else startP4(); });
    resetBtn.addEventListener('click', function () {
      state.currentFill = 'f1';
      fillSelect.value = 'f1';
      lsSetSafe(LS_KEYS.currentFill, 'f1');
      renderFillVisualizer(fillVisual, 'f1', fillTypes);
      renderOnomatoForP4(onomato, state.currentBar, fillTypes, 'f1');
    });

    function startP4() {
      if (!global.Tone) { if (global.STEADY_DEBUG) console.warn('[emolab] Tone.js not loaded'); return; }
      if (global.__steady_active_block_id && global.__steady_active_block_id !== BLOCK_ID) {
        leaveActiveBlock();
      }
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
        global.Tone.Transport.loopEnd = '4m';
        global.Tone.Transport.loop = true;
        // p3 影響回避：swing を明示 0
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
      state.cleanupBound = function () { stopP4(); };
      document.addEventListener('steady:block-leave', state.cleanupBound, { once: true });
    }

    function schedule() {
      if (!global.Tone || !state.kit) return;
      // 8n × 8 step × 4 bar = 32 ticks
      var tickIdx = -1;
      state.repeatId = global.Tone.Transport.scheduleRepeat(function (time) {
        tickIdx = (tickIdx + 1) % 32;
        var barIdx = Math.floor(tickIdx / 8); // 0..3
        var stepInBar = tickIdx % 8;
        var beat = Math.floor(stepInBar / 2);

        if (barIdx < 3) {
          // groove 3 小節：BD 1/3 + SD 2/4 + HH 8 分
          if (stepInBar === 0 && state.kit.kick) {
            try { state.kit.kick.triggerAttackRelease('C2', '8n', time, 0.9); } catch (_) {}
          } else if (stepInBar === 4 && state.kit.kick) {
            try { state.kit.kick.triggerAttackRelease('C2', '8n', time, 0.9); } catch (_) {}
          }
          if (stepInBar === 2 && state.kit.snare) {
            try { state.kit.snare.triggerAttackRelease('16n', time, 0.9); } catch (_) {}
          } else if (stepInBar === 6 && state.kit.snare) {
            try { state.kit.snare.triggerAttackRelease('16n', time, 0.9); } catch (_) {}
          }
          if (state.kit.hihat) {
            try { state.kit.hihat.triggerAttackRelease('F#2', '16n', time, 0.7); } catch (_) {}
          }
        } else {
          // 4 小節目 fill：currentFill に応じた音色
          playFillTick(time, stepInBar);
          if (stepInBar === 7) {
            // フィル 1 周終了 → rotation 適用 + 統計
            scheduleRotateAfterBar();
          }
        }

        global.Tone.Draw.schedule(function () {
          state.activeBarIdx = barIdx;
          state.currentStep = stepInBar;
          updateGrooveTransition(sec, barIdx);
          // onomato は 4 拍位置のみアクティブ
          if (barIdx === state.currentBar - 1) {
            updateOnomatoActive(onomato, beat);
          }
          // Phase1 progress：30 秒以上 + フィル 1 周以上で +5 (max 100)
          if (state.playStartedAt > 0) {
            var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            var elapsed = now - state.playStartedAt;
            if (elapsed >= 30000 && state.playElapsed < 30000 && state.fillsPlayed > 0) {
              lsBumpPhase1Progress(STAGE_ID, 5, 100);
              if (typeof opts.onProgressTick === 'function') opts.onProgressTick();
            }
            state.playElapsed = elapsed;
          }
        }, time);
        try {
          var ts = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          global.SteadyWobble.capture(BLOCK_ID, [ts], []);
        } catch (_) {}
      }, '8n', 0);
    }

    // currentFill の id に応じて 4 小節目の発音を変える（10 種を 8n 単位で簡略再現）
    function playFillTick(time, stepInBar) {
      var f = state.currentFill;
      var k = state.kit;
      if (!k) return;
      if (f === 'f1') {
        // tom 巡回：high→high→mid→mid→mid→low→low→Crash+SD
        if (stepInBar === 0 && k.tomHigh) { try { k.tomHigh.triggerAttackRelease('B2', '8n', time, 0.85); } catch (_) {} }
        if (stepInBar === 1 && k.tomHigh) { try { k.tomHigh.triggerAttackRelease('B2', '8n', time, 0.8); } catch (_) {} }
        if (stepInBar === 2 && k.tomMid)  { try { k.tomMid.triggerAttackRelease('G2', '8n', time, 0.85); } catch (_) {} }
        if (stepInBar === 3 && k.tomMid)  { try { k.tomMid.triggerAttackRelease('G2', '8n', time, 0.8); } catch (_) {} }
        if (stepInBar === 4 && k.tomMid)  { try { k.tomMid.triggerAttackRelease('G2', '8n', time, 0.85); } catch (_) {} }
        if (stepInBar === 5 && k.tomLow)  { try { k.tomLow.triggerAttackRelease('F2', '8n', time, 0.9); } catch (_) {} }
        if (stepInBar === 6 && k.tomLow)  { try { k.tomLow.triggerAttackRelease('F2', '8n', time, 0.85); } catch (_) {} }
        if (stepInBar === 7) {
          if (k.crash) { try { k.crash.triggerAttackRelease('C3', '4n', time, 0.95); } catch (_) {} }
          if (k.snare) { try { k.snare.triggerAttackRelease('16n', time, 0.9); } catch (_) {} }
          if (k.kick)  { try { k.kick.triggerAttackRelease('C2', '8n', time, 0.95); } catch (_) {} }
        }
      } else if (f === 'f2') {
        // SD 16 分連打（8n grid なので 1 step に 1 発、最後アクセント）
        if (k.snare) { try { k.snare.triggerAttackRelease('16n', time, stepInBar === 7 ? 0.95 : 0.7); } catch (_) {} }
      } else if (f === 'f3') {
        // 16 分 linear (K-S-H ローテ)
        var rot = stepInBar % 3;
        if (rot === 0 && k.kick) { try { k.kick.triggerAttackRelease('C2', '8n', time, 0.85); } catch (_) {} }
        if (rot === 1 && k.snare) { try { k.snare.triggerAttackRelease('16n', time, 0.8); } catch (_) {} }
        if (rot === 2 && k.hihat) { try { k.hihat.triggerAttackRelease('F#2', '16n', time, 0.7); } catch (_) {} }
      } else if (f === 'f4') {
        // 6 連符 SD（8n grid 簡略：毎 step SD）
        if (k.snare) { try { k.snare.triggerAttackRelease('16n', time, stepInBar === 7 ? 0.95 : 0.65); } catch (_) {} }
      } else if (f === 'f5') {
        // 8 分→6 連 切替：前半 SD 2 発、後半 SD 連打
        if (stepInBar < 4) {
          if (stepInBar === 0 || stepInBar === 2) { if (k.snare) { try { k.snare.triggerAttackRelease('16n', time, 0.8); } catch (_) {} } }
        } else {
          if (k.snare) { try { k.snare.triggerAttackRelease('16n', time, 0.7); } catch (_) {} }
        }
      } else if (f === 'f6') {
        // tom 16 分 + crash 終端
        var lane = stepInBar % 3;
        var t = (lane === 0) ? k.tomHigh : (lane === 1 ? k.tomMid : k.tomLow);
        var note = (lane === 0) ? 'B2' : (lane === 1 ? 'G2' : 'F2');
        if (stepInBar < 7 && t) { try { t.triggerAttackRelease(note, '8n', time, 0.8); } catch (_) {} }
        if (stepInBar === 7 && k.crash) { try { k.crash.triggerAttackRelease('C3', '4n', time, 0.95); } catch (_) {} }
      } else if (f === 'f7') {
        // BD 連打 + SD アクセント終端
        if (stepInBar < 6 && k.kick) { try { k.kick.triggerAttackRelease('C2', '8n', time, 0.85); } catch (_) {} }
        if (stepInBar === 6 && k.snare) { try { k.snare.triggerAttackRelease('16n', time, 0.95); } catch (_) {} }
        if (stepInBar === 7 && k.snare) { try { k.snare.triggerAttackRelease('16n', time, 1.0); } catch (_) {} }
      } else if (f === 'f8') {
        // ghost → accent crescendo
        var v = 0.3 + stepInBar * 0.09;
        if (k.snare) { try { k.snare.triggerAttackRelease('16n', time, v); } catch (_) {} }
      } else if (f === 'f9') {
        // tom-tom-SD-Crash
        if (stepInBar === 0 || stepInBar === 1) { if (k.tomHigh) { try { k.tomHigh.triggerAttackRelease('B2', '8n', time, 0.85); } catch (_) {} } }
        if (stepInBar === 2 || stepInBar === 3) { if (k.tomMid)  { try { k.tomMid.triggerAttackRelease('G2', '8n', time, 0.85); } catch (_) {} } }
        if (stepInBar === 4 || stepInBar === 5) { if (k.snare) { try { k.snare.triggerAttackRelease('16n', time, 0.85); } catch (_) {} } }
        if (stepInBar === 6 && k.snare) { try { k.snare.triggerAttackRelease('16n', time, 0.95); } catch (_) {} }
        if (stepInBar === 7 && k.crash) { try { k.crash.triggerAttackRelease('C3', '4n', time, 0.95); } catch (_) {} }
      } else if (f === 'f10') {
        // stop fill：1 拍目と最後だけ
        if (stepInBar === 0 && k.snare) { try { k.snare.triggerAttackRelease('16n', time, 0.9); } catch (_) {} }
        if (stepInBar === 7 && k.snare) { try { k.snare.triggerAttackRelease('16n', time, 0.95); } catch (_) {} }
      }
    }

    function scheduleRotateAfterBar() {
      state.fillsPlayed += 1;
      if (state.rotationMode === 'manual') return;
      var ids = fillTypes.map(function (f) { return f.id; });
      if (!ids.length) return;
      var nextId;
      if (state.rotationMode === 'sequential') {
        var idx = ids.indexOf(state.currentFill);
        nextId = ids[(idx + 1) % ids.length];
      } else { // random
        nextId = ids[Math.floor(Math.random() * ids.length)];
      }
      state.currentFill = nextId;
      // UI 反映は Draw 経由
      global.Tone.Draw.schedule(function () {
        try { fillSelect.value = nextId; } catch (_) {}
        lsSetSafe(LS_KEYS.currentFill, nextId);
        renderFillVisualizer(fillVisual, nextId, fillTypes);
        renderOnomatoForP4(onomato, state.currentBar, fillTypes, nextId);
      }, '+0.01');
    }

    function stopP4() {
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
      state.currentStep = -1;
      playBtn.textContent = '再生';
      playBtn.setAttribute('aria-pressed', 'false');
      onomato.querySelectorAll('span[data-active="true"]').forEach(function (e) { e.setAttribute('data-active', 'false'); });
      sec.querySelectorAll('.emo-groove-cell.is-current').forEach(function (e) { e.classList.remove('is-current'); });
      if (state.cleanupBound) {
        document.removeEventListener('steady:block-leave', state.cleanupBound);
        state.cleanupBound = null;
      }
      if (global.__steady_active_block_id === BLOCK_ID) global.__steady_active_block_id = null;
    }

    return { stop: stopP4, dispose: stopP4 };
  }

  // =========================================================
  // 共通 DOM helper（p1〜p8 で共有・p5p8.js は _helper 経由で参照）
  // =========================================================

  // p3/p4 ヘルパ
  function setActiveProgression(sec, bpm) {
    sec.querySelectorAll('.emo-bpm-step').forEach(function (b) {
      b.classList.toggle('active', parseInt(b.getAttribute('data-bpm'), 10) === bpm);
    });
  }
  function setActiveFillSelectability(sec, bar) {
    var sel = sec.querySelector('.emo-fill-select');
    if (!sel) return;
    var isFillBar = (bar === 4);
    sel.disabled = !isFillBar;
    sel.setAttribute('aria-disabled', isFillBar ? 'false' : 'true');
  }
  function updateGrooveTransition(sec, activeBarIdx) {
    sec.querySelectorAll('.emo-groove-cell').forEach(function (cell) {
      var v = parseInt(cell.getAttribute('data-bar'), 10) - 1;
      cell.classList.toggle('is-current', v === activeBarIdx);
    });
  }
  function renderFillVisualizer(rootEl, fillId, fillTypes) {
    if (!rootEl) return;
    var fill = (fillTypes || []).filter(function (f) { return f.id === fillId; })[0];
    if (!fill) { rootEl.innerHTML = ''; return; }
    // 抽象 SVG：8 step を縦バーで密度可視化（記譜記号は使わない）
    // fill_id に応じてバー高さを変える
    var heights;
    if (fillId === 'f1')      heights = [60, 60, 70, 70, 70, 80, 80, 95];
    else if (fillId === 'f2') heights = [55, 55, 55, 55, 55, 55, 55, 95];
    else if (fillId === 'f3') heights = [70, 65, 60, 70, 65, 60, 70, 95];
    else if (fillId === 'f4') heights = [55, 55, 55, 55, 55, 55, 55, 95];
    else if (fillId === 'f5') heights = [60, 0, 60, 0, 50, 50, 50, 95];
    else if (fillId === 'f6') heights = [60, 60, 60, 60, 60, 60, 60, 95];
    else if (fillId === 'f7') heights = [70, 70, 70, 70, 70, 70, 80, 95];
    else if (fillId === 'f8') heights = [25, 35, 45, 55, 65, 75, 85, 95];
    else if (fillId === 'f9') heights = [70, 70, 70, 70, 65, 65, 80, 95];
    else if (fillId === 'f10') heights = [70, 0, 0, 0, 0, 0, 0, 95];
    else heights = [50, 50, 50, 50, 50, 50, 50, 50];
    var bars = '';
    for (var i = 0; i < 8; i++) {
      var h = Math.max(6, heights[i] || 0);
      bars += '<rect x="' + (10 + i * 22) + '" y="' + (110 - h) + '" width="14" height="' + h + '" rx="2" fill="var(--accent)" opacity="' + (0.4 + (h / 100) * 0.6) + '"></rect>';
    }
    var label = '<text x="100" y="130" fill="var(--muted)" font-size="11" text-anchor="middle">' + fill.id.toUpperCase() + '：' + fill.name + '</text>';
    rootEl.innerHTML = '<svg viewBox="0 0 200 140" role="img" aria-label="' + fill.name + ' のフィル形状（抽象表示）" width="100%" height="140">' + bars + label + '</svg>';
  }
  function renderOnomatoForP4(rootEl, bar, fillTypes, currentFill) {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    if (bar < 4) {
      // groove：4 拍ともドンタン
      ['ドン', 'タン', 'ドン', 'タン'].forEach(function (s, beat) {
        var span = document.createElement('span');
        span.textContent = s;
        span.setAttribute('data-step', String(beat));
        span.setAttribute('data-active', 'false');
        // T-07 LOW-1 / Run 7 UX-08: 休符 `_` は SR 読み上げ対象外 aria-hidden="true"
        if (s === '_') {
          span.setAttribute('aria-hidden', 'true');
          span.classList.add('emo-onomato-rest');
        }
        rootEl.appendChild(span);
      });
    } else {
      // fill：currentFill のオノマトペを 4 分割
      var fill = (fillTypes || []).filter(function (f) { return f.id === currentFill; })[0];
      var ono = (fill && fill.onomatopoeia) || 'ドンタン';
      // 4 拍に粗く分割（半角 = 1, 全角 = 2 として均等割は冗長なので、文字数 / 4 で前から切る）
      var per = Math.max(1, Math.ceil(ono.length / 4));
      for (var i = 0; i < 4; i++) {
        var seg = ono.slice(i * per, (i + 1) * per) || '';
        var span = document.createElement('span');
        span.textContent = seg;
        span.setAttribute('data-step', String(i));
        span.setAttribute('data-active', 'false');
        // T-07 LOW-1 / Run 7 UX-08: 休符 `_` のみのセグメントは SR 読み上げ対象外 aria-hidden="true"
        if (seg === '_') {
          span.setAttribute('aria-hidden', 'true');
          span.classList.add('emo-onomato-rest');
        }
        rootEl.appendChild(span);
      }
    }
  }

  // ---------------------------------------------------------
  // HTML / DOM helpers
  // ---------------------------------------------------------
  function renderControlsHtml(prefix, bpm, spec) {
    var min = spec.bpm_range && spec.bpm_range[0] || 40;
    var max = spec.bpm_range && spec.bpm_range[1] || 240;
    return '<div class="emo-lab-controls">' +
      '<div class="control-group">' +
        '<button type="button" class="btn-primary emo-play-btn" aria-label="再生 / 一時停止" aria-pressed="false">再生</button>' +
        '<button type="button" class="btn-secondary emo-record-btn" disabled title="B10 実装後に有効化" aria-label="録音（B10 実装後に有効化）">録音</button>' +
        '<button type="button" class="btn-secondary emo-reset-btn" aria-label="プリセットを再読込">プリセット</button>' +
      '</div>' +
      '<div class="control-group">' +
        '<label for="' + prefix + '-bpm">BPM</label>' +
        '<input id="' + prefix + '-bpm" class="emo-bpm-slider" type="range" min="' + min + '" max="' + max + '" step="1" value="' + bpm + '" aria-label="BPM スライダー">' +
        '<span class="emo-bpm-value">' + bpm + '</span>' +
      '</div>' +
    '</div>';
  }
  function renderProgressionHtml(prefix, progression, currentBpm) {
    if (!Array.isArray(progression) || !progression.length) return '';
    var html = '<div class="emo-bpm-progression" role="group" aria-label="推奨 BPM 進行">';
    progression.forEach(function (v) {
      html += '<button type="button" class="emo-bpm-step' + (v === currentBpm ? ' active' : '') + '" data-bpm="' + v + '">' + v + '</button>';
    });
    html += '</div>';
    return html;
  }
  function renderStepGridHtml(prefix) {
    var html = '<div class="emo-step-seq" role="grid" aria-label="ステップシーケンサー 4×16">';
    ROWS.forEach(function (row) {
      html += '<div class="emo-step-row" role="row" data-row-label="' + row + '">';
      html += '<div class="emo-step-row-label" role="rowheader">' + row + '</div>';
      for (var i = 0; i < 16; i++) {
        html += '<button type="button" class="emo-step" data-row="' + row + '" data-col="' + i + '" data-state="off" aria-label="' + row + ' step ' + (i + 1) + '"></button>';
      }
      html += '</div>';
    });
    html += '</div>';
    return html;
  }
  function renderGrid(grid, steps) {
    if (!grid || !steps) return;
    ROWS.forEach(function (row) {
      var cells = grid.querySelectorAll('[data-row="' + row + '"]');
      var rowSteps = steps[row] || [];
      cells.forEach(function (cell) {
        var col = parseInt(cell.getAttribute('data-col'), 10);
        if (isNaN(col)) return;
        cell.setAttribute('data-state', rowSteps[col] || 'off');
      });
    });
  }
  function updateGridCurrent(grid, stepIdx) {
    if (!grid) return;
    grid.querySelectorAll('.emo-step.is-current').forEach(function (e) { e.classList.remove('is-current'); });
    grid.querySelectorAll('[data-col="' + stepIdx + '"]').forEach(function (e) { e.classList.add('is-current'); });
  }
  function renderOnomato(rootEl, syncs) {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    if (!Array.isArray(syncs)) return;
    syncs.forEach(function (s) {
      var stepIdx = timeToStep(s.time);
      var span = document.createElement('span');
      span.textContent = s.syllable || '';
      span.setAttribute('data-step', String(stepIdx == null ? -1 : stepIdx));
      span.setAttribute('data-active', 'false');
      // T-07 LOW-1 / Run 7 UX-08: 休符 `_` は SR 読み上げ対象外 aria-hidden="true"
      if (s.syllable === '_') {
        span.setAttribute('aria-hidden', 'true');
        span.classList.add('emo-onomato-rest');
      }
      rootEl.appendChild(span);
    });
  }
  // onomato は半二重マッチ依存（time→step semantics・A-4 で吸収）
  function updateOnomatoActive(rootEl, currentVal) {
    if (!rootEl) return;
    var spans = rootEl.querySelectorAll('span[data-step]');
    if (!spans.length) return;
    // 半二重マッチ：呼出側が beat (0..3) を渡すが span の data-step は 16th step（0..15）の場合がある
    // → 同じ rootEl 内で max(data-step) を見て semantics を判定
    var maxStep = -1;
    spans.forEach(function (sp) {
      var s = parseInt(sp.getAttribute('data-step'), 10);
      if (!isNaN(s) && s > maxStep) maxStep = s;
    });
    var beatSemantics = maxStep <= 3 && currentVal <= 3; // どちらも beat 領域なら直接比較
    spans.forEach(function (sp) {
      var s = parseInt(sp.getAttribute('data-step'), 10);
      var match;
      if (beatSemantics) {
        match = s === currentVal;
      } else if (currentVal <= 3 && maxStep > 3) {
        // 呼出側 beat (0..3) × span 16th step (0,4,8,12,...) → 4 倍して比較 or beat 単位で割って比較
        match = Math.floor(s / 4) === currentVal;
      } else {
        match = s === currentVal;
      }
      sp.setAttribute('data-active', match ? 'true' : 'false');
    });
  }
  function renderOnomatoForP2(rootEl, spec, barIdx) {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    var variation = (spec.variations && spec.variations[barIdx - 1]) || spec.variations[0];
    if (!variation) return;
    [0, 1, 2, 3].forEach(function (beat) {
      var span = document.createElement('span');
      var ono = variation.onomatopoeia || '';
      span.textContent = ono;
      span.setAttribute('data-step', String(beat));
      span.setAttribute('data-active', 'false');
      // T-07 LOW-1 / Run 7 UX-08: 休符 `_` は SR 読み上げ対象外 aria-hidden="true"
      if (ono === '_') {
        span.setAttribute('aria-hidden', 'true');
        span.classList.add('emo-onomato-rest');
      }
      rootEl.appendChild(span);
    });
  }
  function renderStickIndicator(rootEl, midiNotes) {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    if (!Array.isArray(midiNotes)) return;
    var sdNotes = midiNotes.filter(function (n) { return n.note === 'D2' && timeToStep(n.time) != null; });
    sdNotes.sort(function (a, b) { return (timeToStep(a.time) || 0) - (timeToStep(b.time) || 0); });
    sdNotes.forEach(function (n) {
      var stepIdx = timeToStep(n.time);
      var stick = n.stick || '?';
      var span = document.createElement('span');
      // B8 Run 5 G2（UX-15 R/L 可視化）：右手は .hand-R、左手は .hand-L、aria-label を付与
      var classes = 'emo-stick';
      if (stick === 'R' || stick === 'r') {
        classes += ' hand-R';
        span.setAttribute('aria-label', '右手');
      } else if (stick === 'L' || stick === 'l') {
        classes += ' hand-L';
        span.setAttribute('aria-label', '左手');
      }
      span.className = classes;
      span.textContent = stick;
      span.setAttribute('data-step', String(stepIdx == null ? -1 : stepIdx));
      rootEl.appendChild(span);
    });
  }
  function updateStickActive(rootEl, currentStep) {
    if (!rootEl) return;
    rootEl.querySelectorAll('.emo-stick.is-current').forEach(function (e) { e.classList.remove('is-current'); });
    var match = rootEl.querySelector('.emo-stick[data-step="' + currentStep + '"]');
    if (match) {
      match.classList.add('is-current');
      // B8 Run 5 G2（UX-15）：現在 step の手 (hand-R / hand-L) に応じて aria-current を付与
      // → スクリーンリーダー利用者にも現在打点の左右が伝わる
      if (match.classList.contains('hand-R')) {
        match.setAttribute('aria-current', 'true');
      } else if (match.classList.contains('hand-L')) {
        match.setAttribute('aria-current', 'true');
      }
      // 直前 step の aria-current 解除（is-current 解除と同じスコープ内）
      rootEl.querySelectorAll('.emo-stick[aria-current="true"]').forEach(function (e) {
        if (e !== match) e.removeAttribute('aria-current');
      });
    }
  }

  // p2 ヘルパ
  function buildStepsByBarFromSpec(spec) {
    var bars = [makeEmptySteps(), makeEmptySteps(), makeEmptySteps(), makeEmptySteps()];
    if (!spec.groove_per_bar || !spec.variations) return bars;
    spec.variations.forEach(function (variation, bIdx) {
      spec.groove_per_bar.forEach(function (g) {
        var sIdx = timeToStep(g.time);
        if (sIdx == null) return;
        var row = g.track || null;
        if (!row) return;
        // BD/SD の velocity は 0.85/0.9 → accent、HH は normal
        var state = (row === 'HH') ? 'normal' : 'accent';
        bars[bIdx][row][sIdx] = state;
      });
    });
    return bars;
  }
  function setActiveBarTab(sec, bar) {
    sec.querySelectorAll('.emo-bar-tab').forEach(function (b) {
      var v = parseInt(b.getAttribute('data-bar'), 10);
      b.classList.toggle('active', v === bar);
      b.setAttribute('aria-checked', v === bar ? 'true' : 'false');
    });
  }
  function setActiveOpennessTab(sec, step) {
    var values = [0, 25, 50, 100];
    var target = values[step - 1];
    sec.querySelectorAll('.emo-openness-tab').forEach(function (b) {
      var v = parseInt(b.getAttribute('data-openness'), 10);
      b.classList.toggle('active', v === target);
    });
  }
  function opennessToStep(o) {
    if (o <= 12)  return 1;
    if (o <= 37)  return 2;
    if (o <= 75)  return 3;
    return 4;
  }
  function opennessToVariation(o, spec) {
    var s = opennessToStep(o);
    return (spec.variations && spec.variations[s - 1]) || null;
  }
  function opennessToLabel(o, spec) {
    var v = opennessToVariation(o, spec);
    return v ? v.label : 'closed';
  }
  function drawKnob(canvas, openness) {
    if (!canvas || !canvas.getContext) return;
    var dpr = global.devicePixelRatio || 1;
    var size = 64;
    // B4 採用：dpr Math.ceil 化（B4 BeatWheel と同方針）
    canvas.width = Math.ceil(size * dpr);
    canvas.height = Math.ceil(size * dpr);
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    var styles = global.getComputedStyle ? getComputedStyle(document.body) : null;
    var border = (styles && styles.getPropertyValue('--border').trim()) || '#ccc';
    var accent = (styles && styles.getPropertyValue('--accent').trim()) || '#7c6af7';
    var bg     = (styles && styles.getPropertyValue('--bg').trim()) || '#fff';
    var cx = size / 2, cy = size / 2;
    var rOut = size * 0.4;
    var rIn  = size * 0.18;
    // outer ring (always)
    ctx.beginPath();
    ctx.arc(cx, cy, rOut, 0, Math.PI * 2);
    ctx.strokeStyle = border;
    ctx.lineWidth = 2;
    ctx.stroke();
    // openness fill
    var pct = Math.max(0, Math.min(100, openness)) / 100;
    if (pct === 0) {
      // closed = 中心まで塗り
      ctx.beginPath();
      ctx.arc(cx, cy, rOut - 2, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
    } else if (pct >= 1) {
      // full open = リングのみ
      // already drawn above
    } else {
      // partial = 中央側を塗り、開口を背景色で打ち抜く
      ctx.beginPath();
      ctx.arc(cx, cy, rOut - 2, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      // 開口部（円弧）
      ctx.beginPath();
      ctx.arc(cx, cy, rOut - 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
      ctx.lineTo(cx, cy);
      ctx.closePath();
      ctx.fillStyle = bg;
      ctx.fill();
    }
    // 中央コア
    ctx.beginPath();
    ctx.arc(cx, cy, rIn, 0, Math.PI * 2);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // ---------------------------------------------------------
  // mountP1〜P4 公開（mount router 本体は p5p8.js）
  // ---------------------------------------------------------
  global.SteadyEmoLab.mountP1 = mountP1;
  global.SteadyEmoLab.mountP2 = mountP2;
  global.SteadyEmoLab.mountP3 = mountP3;
  global.SteadyEmoLab.mountP4 = mountP4;

  // _helper 経由で p5p8.js が DOM helper を共有する
  H.renderControlsHtml         = renderControlsHtml;
  H.renderProgressionHtml      = renderProgressionHtml;
  H.renderStepGridHtml         = renderStepGridHtml;
  H.renderGrid                 = renderGrid;
  H.updateGridCurrent          = updateGridCurrent;
  H.renderOnomato              = renderOnomato;
  H.updateOnomatoActive        = updateOnomatoActive;
  H.setActiveProgression       = setActiveProgression;
  H.setActiveBarTab            = setActiveBarTab;
  H.setActiveFillSelectability = setActiveFillSelectability;
  H.updateGrooveTransition     = updateGrooveTransition;
  H.renderFillVisualizer       = renderFillVisualizer;
  H.renderOnomatoForP4         = renderOnomatoForP4;

  global.SteadyEmoLab._p1p4_loaded = true;
})(typeof window !== 'undefined' ? window : globalThis);
