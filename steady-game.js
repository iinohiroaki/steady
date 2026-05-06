/* =============================================================
   STEADY v3.2.0r2 block8-h5 — Phase D ゲーム実装（steady-game.js）
   発注書：00_社内システム/06_AI運用台帳/発注書/2026-05-06_AL007_steady_v3.2.0r2_phase_d_game_implementation_autobattle.md
   実装：AL007 井上ドーナツ
   Date: 2026-05-06

   概要：
     - オートバトル（観戦型・自動進行 30〜90 秒）
     - 多段階 HP ボス（phases:[] 形態移行）
     - XP / コイン / 装備 3 軸独立
     - 練習充電（chargeFromPractice）：steady-use-log.js を read-only で参照
     - ドラム神話系敵 8 体（拍神 / 雷神ドラム / リズム巫女 / ...）
     - やりこみ：titles / records / prestige / mergeEquipment / 隠し妖怪

   依存：
     - window.SteadyShared（LS_V32 / lsGet / lsSet）
     - window.SteadyUseLog（getSummary / getDailyUseCount） read-only
   ============================================================= */

(function (global) {
  'use strict';

  // ---- defensive shims ---------------------------------------------------
  var S = global.SteadyShared;
  if (!S || !S.LS_V32 || !S.LS_V32.GAME_STATE) {
    if (global.STEADY_DEBUG) console.warn('[steady-game] SteadyShared/LS_V32 unavailable; aborting init');
    return;
  }
  var LS_KEY = S.LS_V32.GAME_STATE;
  var lsGet = S.lsGet, lsSet = S.lsSet;

  // -------------------------------------------------------------
  // 1. 静的データ：敵テーブル（ドラム神話系 8 体・発注書 §1-5 既定値）
  // -------------------------------------------------------------
  // phases[]：1 体につき 1〜3 段階。最後の phase で HP→0 ＝ 撃破。
  // 怒り化（rage）：phase 移行時に atk×1.3, accent color, セリフ。
  var ENEMIES = [
    {
      id: 'haku_gami',
      name: '拍神',
      title: 'はくがみ',
      motif: '拍の起源神',
      unlockLevel: 1,
      isHidden: false,
      isBoss: false,
      reward: { xp: 25, coin: 8, dropChance: 0.55 },
      phases: [{ hp: 90, atk: 7, color: '#7a8edb', cry: 'カチ…カチ…' }],
      lines: { intro: '拍の根が震える…', win: '良き拍だ', lose: '拍に呑まれた…' }
    },
    {
      id: 'thunder_drum',
      name: '雷神ドラム',
      title: 'らいじん',
      motif: '雷×太鼓伝承',
      unlockLevel: 3,
      isHidden: false,
      isBoss: false,
      reward: { xp: 45, coin: 14, dropChance: 0.6 },
      phases: [{ hp: 160, atk: 12, color: '#facc15', cry: 'ゴロゴロ…ドンッ' }],
      lines: { intro: '雲が割れる', win: '雷鳴が静まった', lose: '撃たれた…' }
    },
    {
      id: 'rhythm_miko',
      name: 'リズム巫女',
      title: 'みこ',
      motif: '巫女舞×複合拍',
      unlockLevel: 5,
      isHidden: false,
      isBoss: false,
      reward: { xp: 70, coin: 22, dropChance: 0.65 },
      phases: [
        { hp: 180, atk: 14, color: '#f472b6', cry: '舞が始まる…' },
        { hp: 140, atk: 19, color: '#ec4899', cry: '【二段拍】真の舞いを見せよう' }
      ],
      lines: { intro: '神楽鈴が鳴る', win: '舞は終わった', lose: '神楽に魅せられた…' }
    },
    {
      id: 'eight_drum',
      name: '八叉太鼓',
      title: 'やまた',
      motif: 'ヤマタノオロチ×8パート',
      unlockLevel: 8,
      isBoss: true,
      isHidden: false,
      reward: { xp: 140, coin: 50, dropChance: 0.8 },
      phases: [
        { hp: 280, atk: 18, color: '#16a34a', cry: '八つの首が呼応する' },
        { hp: 220, atk: 26, color: '#dc2626', cry: '【怒り】首が四つ落ちた…許さぬ' }
      ],
      lines: { intro: '八つの首が首を擡げる', win: '八叉、討ち取った', lose: '飲まれた…' }
    },
    {
      id: 'wind_shaker',
      name: '風神シェイカー',
      title: 'ふうじん',
      motif: '風神×シェイカー神話',
      unlockLevel: 10,
      isHidden: false,
      isBoss: false,
      reward: { xp: 100, coin: 30, dropChance: 0.6 },
      phases: [{ hp: 260, atk: 22, color: '#22d3ee', cry: 'シャッ…シャッ' }],
      lines: { intro: '風袋が膨らむ', win: '風が止んだ', lose: '吹き飛ばされた…' }
    },
    {
      id: 'tsukuyomi_click',
      name: '月読クリック',
      title: 'つくよみ',
      motif: '月読×等間隔神話',
      unlockLevel: 12,
      isHidden: false,
      isBoss: false,
      reward: { xp: 130, coin: 40, dropChance: 0.62 },
      phases: [{ hp: 320, atk: 26, color: '#a78bfa', cry: 'ピッ…ピッ…ピッ' }],
      lines: { intro: '月読が等間隔を刻む', win: '月が雲に隠れた', lose: '時が止まった…' }
    },
    {
      id: 'kusanagi_snare',
      name: '天叢雲スネア',
      title: 'あまのむらくも',
      motif: '草薙×バックビート',
      unlockLevel: 15,
      isBoss: true,
      isHidden: false,
      reward: { xp: 220, coin: 80, dropChance: 0.85 },
      phases: [
        { hp: 360, atk: 28, color: '#94a3b8', cry: '草を薙ぐ音…' },
        { hp: 280, atk: 36, color: '#64748b', cry: '【二段】鞘が外れる' },
        { hp: 200, atk: 48, color: '#1e293b', cry: '【最終】真名・天叢雲！' }
      ],
      lines: { intro: '伝承の刃が鳴る', win: '神剣を制した', lose: '斬られた…' }
    },
    {
      id: 'amatsu_drummer',
      name: '始祖アマツドラマー',
      title: 'はじまりの神',
      motif: '創世神話×全パート統合',
      unlockLevel: 20,
      isBoss: true,
      isHidden: false,
      reward: { xp: 400, coin: 160, dropChance: 0.95 },
      phases: [
        { hp: 480, atk: 36, color: '#fde68a', cry: '原初の鼓動…' },
        { hp: 360, atk: 48, color: '#fbbf24', cry: '【二段】創世のリズムだ' },
        { hp: 280, atk: 64, color: '#b91c1c', cry: '【最終】我は始祖、汝の根源' }
      ],
      lines: { intro: '宇宙のテンポが現れる', win: '始祖を討った…！', lose: '創世に呑まれた…' }
    },
    // 隠し妖怪（unlockLevel ではなく hidden 条件）
    {
      id: 'midnight_shadow',
      name: '深夜の影',
      title: 'シャドウ',
      motif: '深夜練習',
      unlockLevel: 999,
      isHidden: true,
      hiddenCondition: 'midnight_practice', // 22:00〜04:00 に練習があれば解禁
      isBoss: false,
      reward: { xp: 200, coin: 60, dropChance: 0.9 },
      phases: [{ hp: 300, atk: 30, color: '#0f172a', cry: '…誰だ' }],
      lines: { intro: '夜の中に何かいる', win: '影は消えた', lose: '闇に飲まれた…' }
    },
    {
      id: 'streak_demon',
      name: '十四日鬼',
      title: 'じゅうよっか',
      motif: '14 日連続練習',
      unlockLevel: 999,
      isHidden: true,
      hiddenCondition: 'streak_14', // streakDays >= 14
      isBoss: true,
      reward: { xp: 500, coin: 200, dropChance: 1.0 },
      phases: [
        { hp: 600, atk: 50, color: '#7c3aed', cry: '十四日…貴様、よく続けたな' },
        { hp: 400, atk: 70, color: '#4c1d95', cry: '【真鬼】見せてみろ、その意地を' }
      ],
      lines: { intro: '継続の鬼が現れる', win: '己に勝った', lose: '惜しい…継続せよ' }
    },

    // =============================================================
    // v3.3.0 新規追加 50 体（既存 10 体 + 新規 50 体 = 60 体）
    // 配置設計：通常 28 / 中ボス 12 / 大ボス 6 / 隠し 4
    // 神話モチーフ：日本 25（Kojiki 系 15 + 民俗・妖怪 10）+ 海外 25
    // 文化整合：実名借用（Damaru / Thor / Anubis 等）は敬意ある motif 必須
    // =============================================================

    // ---- 日本神話 Kojiki 系 15 体 -------------------------------
    {
      id: 'susanoo',
      name: '須佐之男',
      title: 'すさのお',
      motif: '嵐神・八岐大蛇討伐の象徴。荒ぶる拍を司る',
      unlockLevel: 18,
      isHidden: false,
      isBoss: true,
      reward: { xp: 240, coin: 90, dropChance: 0.8 },
      phases: [
        { hp: 455, atk: 26, color: '#1d4ed8', cry: '嵐の前触れ…' },
        { hp: 341, atk: 34, color: '#1e3a8a', cry: '【荒魂】我は嵐の神なり' }
      ],
      lines: { intro: '高天原の嵐神が降り立つ', win: '嵐は去った', lose: '荒拍に呑まれた…' }
    },
    {
      id: 'ame_no_uzume_alt',
      name: '天宇受売別態',
      title: 'うずめ',
      motif: '天岩戸別バリエ・舞踏拍の化身',
      unlockLevel: 6,
      isHidden: false,
      isBoss: false,
      reward: { xp: 80, coin: 24, dropChance: 0.62 },
      phases: [{ hp: 224, atk: 16, color: '#fb7185', cry: '神楽の鈴が鳴る…' }],
      lines: { intro: '岩戸の前で舞いが始まる', win: '舞は静まった', lose: '舞に魅せられた…' }
    },
    {
      id: 'tsukuyomi_no_mikoto',
      name: '月夜見尊',
      title: 'つくよみのみこと',
      motif: '夜の調拍・月の運行を司る神',
      unlockLevel: 14,
      isHidden: false,
      isBoss: false,
      reward: { xp: 150, coin: 46, dropChance: 0.62 },
      phases: [{ hp: 416, atk: 28, color: '#6366f1', cry: '月光の調…' }],
      lines: { intro: '月の神が夜を整える', win: '月が満ちた', lose: '夜に飲まれた…' }
    },
    {
      id: 'izanagi',
      name: '伊弉諾',
      title: 'いざなぎ',
      motif: '創造拍・国産み神話の根源',
      unlockLevel: 25,
      isHidden: false,
      isBoss: true,
      reward: { xp: 360, coin: 140, dropChance: 0.82 },
      phases: [
        { hp: 579, atk: 32, color: '#f59e0b', cry: '国を産む拍が鳴る…' },
        { hp: 441, atk: 42, color: '#d97706', cry: '【創造】次なる島を産まん' }
      ],
      lines: { intro: '創造神が現れる', win: '創造は静まった', lose: '産み出されたものに飲まれた…' }
    },
    {
      id: 'izanami',
      name: '伊弉冉',
      title: 'いざなみ',
      motif: '黄泉拍・死と再生を司る母神。敬意を込めた重低音',
      unlockLevel: 30,
      isHidden: false,
      isBoss: true,
      reward: { xp: 520, coin: 220, dropChance: 0.85 },
      phases: [
        { hp: 655, atk: 42, color: '#831843', cry: '黄泉の拍が響く…' },
        { hp: 485, atk: 56, color: '#500724', cry: '【黄泉醜女】見るな、と言うたぞ' },
        { hp: 340, atk: 72, color: '#1c0518', cry: '【黄泉大神】我が国へ来よ' }
      ],
      lines: { intro: '黄泉比良坂が口を開ける', win: '黄泉は閉ざされた', lose: '黄泉に引き込まれた…' }
    },
    {
      id: 'sukunabikona',
      name: '少名毘古那',
      title: 'すくなびこな',
      motif: '小神・速拍の化身。素早い手数で挑む',
      unlockLevel: 7,
      isHidden: false,
      isBoss: false,
      reward: { xp: 90, coin: 26, dropChance: 0.6 },
      phases: [{ hp: 248, atk: 18, color: '#86efac', cry: 'カラカラ…' }],
      lines: { intro: '小神が舞い降りる', win: '小神は雲に去った', lose: '速拍に追い抜かれた…' }
    },
    {
      id: 'watatsumi',
      name: '海神綿津見',
      title: 'わたつみ',
      motif: '波打ち拍・海の神。潮の満ち引きを刻む',
      unlockLevel: 11,
      isHidden: false,
      isBoss: false,
      reward: { xp: 120, coin: 36, dropChance: 0.62 },
      phases: [{ hp: 344, atk: 22, color: '#0e7490', cry: '潮騒の拍…' }],
      lines: { intro: '海底から拍が昇る', win: '潮は引いた', lose: '波に呑まれた…' }
    },
    {
      id: 'sarutahiko',
      name: '猿田彦',
      title: 'さるたひこ',
      motif: '道反・分岐拍の神。岐路を司る',
      unlockLevel: 9,
      isHidden: false,
      isBoss: false,
      reward: { xp: 105, coin: 32, dropChance: 0.6 },
      phases: [{ hp: 296, atk: 20, color: '#b45309', cry: '道は分かれる…' }],
      lines: { intro: '岐路の神が現れる', win: '道は定まった', lose: '迷い拍に呑まれた…' }
    },
    {
      id: 'amenotajikarao',
      name: '天手力男',
      title: 'たぢからお',
      motif: '岩戸開き・パワー拍の象徴。怪力で岩戸を引く',
      unlockLevel: 16,
      isHidden: false,
      isBoss: true,
      reward: { xp: 200, coin: 70, dropChance: 0.78 },
      phases: [
        { hp: 422, atk: 24, color: '#92400e', cry: '岩戸を引く…' },
        { hp: 310, atk: 32, color: '#78350f', cry: '【怪力】岩戸を投げ飛ばす！' }
      ],
      lines: { intro: '岩戸の神が腕を構える', win: '岩戸は開いた', lose: '岩戸に閉じ込められた…' }
    },
    {
      id: 'ookuninushi',
      name: '大国主',
      title: 'おおくにぬし',
      motif: '出雲・低音拍の神。国譲りの寛容さ',
      unlockLevel: 13,
      isHidden: false,
      isBoss: false,
      reward: { xp: 145, coin: 44, dropChance: 0.62 },
      phases: [{ hp: 392, atk: 25, color: '#7c2d12', cry: '出雲の低音…' }],
      lines: { intro: '出雲の主が降り立つ', win: '国は譲られた', lose: '低音に圧された…' }
    },
    {
      id: 'takemikazuchi',
      name: '建御雷',
      title: 'たけみかづち',
      motif: '雷剣・スネア神。神威ある一撃',
      unlockLevel: 22,
      isHidden: false,
      isBoss: true,
      reward: { xp: 280, coin: 110, dropChance: 0.8 },
      phases: [
        { hp: 537, atk: 30, color: '#facc15', cry: '剣の閃光…' },
        { hp: 387, atk: 40, color: '#ca8a04', cry: '【雷剣】神威の一撃！' }
      ],
      lines: { intro: '雷剣の神が降臨する', win: '雷剣は鞘に戻った', lose: '雷剣に貫かれた…' }
    },
    {
      id: 'oyamatsumi',
      name: '大山祇',
      title: 'おおやまつみ',
      motif: '山岳・タム神。重厚な低音タム',
      unlockLevel: 17,
      isHidden: false,
      isBoss: false,
      reward: { xp: 180, coin: 56, dropChance: 0.65 },
      phases: [{ hp: 488, atk: 30, color: '#365314', cry: '山が鳴動する…' }],
      lines: { intro: '山の神が動く', win: '山は静まった', lose: '山鳴りに呑まれた…' }
    },
    {
      id: 'konohanasakuya',
      name: '木花咲耶姫',
      title: 'このはなさくや',
      motif: '桜・装飾拍の女神。儚く華やかな装飾音',
      unlockLevel: 10,
      isHidden: false,
      isBoss: false,
      reward: { xp: 115, coin: 34, dropChance: 0.62 },
      phases: [{ hp: 320, atk: 19, color: '#fbcfe8', cry: '桜が舞う…' }],
      lines: { intro: '桜の女神が降り立つ', win: '桜は散った', lose: '装飾拍に魅せられた…' }
    },
    {
      id: 'yamatotakeru',
      name: '倭建命',
      title: 'やまとたける',
      motif: '東征・進軍拍の英雄。力強い行進',
      unlockLevel: 19,
      isHidden: false,
      isBoss: false,
      reward: { xp: 210, coin: 68, dropChance: 0.66 },
      phases: [
        { hp: 402, atk: 24, color: '#9f1239', cry: '進軍の拍…' },
        { hp: 288, atk: 32, color: '#881337', cry: '【白鳥】我が魂、白鳥となりて飛ぶ' }
      ],
      lines: { intro: '英雄の拍が響く', win: '英雄は伝説となった', lose: '進軍に踏み潰された…' }
    },
    {
      id: 'omononushi',
      name: '大物主',
      title: 'おおものぬし',
      motif: '蛇神・ポリリズムの大ボス。三輪山の主',
      unlockLevel: 32,
      isHidden: false,
      isBoss: true,
      reward: { xp: 580, coin: 240, dropChance: 0.85 },
      phases: [
        { hp: 682, atk: 44, color: '#064e3b', cry: '三輪の蛇身…' },
        { hp: 512, atk: 58, color: '#022c22', cry: '【ポリリズム】3:5 の蛇拍を聴け' },
        { hp: 366, atk: 76, color: '#0f0f0f', cry: '【三輪大神】神威を見せん' }
      ],
      lines: { intro: '三輪山の蛇神が現れる', win: '三輪は静まった', lose: 'ポリリズムに巻かれた…' }
    },

    // ---- 日本民俗・妖怪 10 体 -----------------------------------
    {
      id: 'kappa',
      name: '河童',
      title: 'かっぱ',
      motif: '水拍・トリッキーな小妖。皿の水を狙え',
      unlockLevel: 4,
      isHidden: false,
      isBoss: false,
      reward: { xp: 60, coin: 18, dropChance: 0.58 },
      phases: [{ hp: 176, atk: 11, color: '#22c55e', cry: 'ピチャ…ピチャ…' }],
      lines: { intro: '川面が揺れる', win: '河童は川へ帰った', lose: '皿の水に引き込まれた…' }
    },
    {
      id: 'tengu',
      name: '天狗',
      title: 'てんぐ',
      motif: '山道拍・速攻の妖。羽団扇で風を巻く',
      unlockLevel: 8,
      isHidden: false,
      isBoss: false,
      reward: { xp: 95, coin: 28, dropChance: 0.6 },
      phases: [{ hp: 272, atk: 20, color: '#dc2626', cry: 'ヒュゥ…' }],
      lines: { intro: '山道に羽音がする', win: '天狗は山へ消えた', lose: '羽団扇に煽られた…' }
    },
    {
      id: 'yamauba',
      name: '山姥',
      title: 'やまうば',
      motif: '深山拍・気まぐれな老婆。山奥の不規則拍',
      unlockLevel: 12,
      isHidden: false,
      isBoss: false,
      reward: { xp: 130, coin: 40, dropChance: 0.62 },
      phases: [{ hp: 368, atk: 24, color: '#57534e', cry: 'ホホホ…' }],
      lines: { intro: '深山に笑い声', win: '山姥は霧に消えた', lose: '深山に迷い込んだ…' }
    },
    {
      id: 'shutendoji',
      name: '酒呑童子',
      title: 'しゅてんどうじ',
      motif: '鬼神大ボス・大江山の頭領。豪快な乱拍',
      unlockLevel: 26,
      isHidden: false,
      isBoss: true,
      reward: { xp: 380, coin: 150, dropChance: 0.82 },
      phases: [
        { hp: 606, atk: 32, color: '#b91c1c', cry: '盃が鳴る…' },
        { hp: 446, atk: 44, color: '#7f1d1d', cry: '【酩酊】我は大江山の主ぞ' }
      ],
      lines: { intro: '大江山の鬼神が現れる', win: '鬼神は討ち取られた', lose: '盃に飲まれた…' }
    },
    {
      id: 'nue',
      name: '鵺',
      title: 'ぬえ',
      motif: '不吉拍・隠し妖。猿頭・狸胴・虎手足・蛇尾の合成獣',
      unlockLevel: 999,
      isHidden: true,
      hiddenCondition: 'losses_3_streak', // 3連敗後に出現
      isBoss: false,
      reward: { xp: 280, coin: 90, dropChance: 0.85 },
      phases: [
        { hp: 344, atk: 28, color: '#3f3f46', cry: 'ヒョォーー…' },
        { hp: 236, atk: 38, color: '#27272a', cry: '【不吉】お前の弱さを喰らいに来た' }
      ],
      lines: { intro: '夜空に不吉な鳴き声', win: '鵺は雲へ消えた', lose: '不吉に飲まれた…' }
    },
    {
      id: 'zashiki_warashi',
      name: '座敷童',
      title: 'ざしきわらし',
      motif: '家拍・福をもたらす童。優しい等間隔',
      unlockLevel: 15,
      isHidden: false,
      isBoss: true,
      reward: { xp: 180, coin: 60, dropChance: 0.78 },
      phases: [
        { hp: 414, atk: 22, color: '#fde047', cry: 'トコトコ…' },
        { hp: 286, atk: 30, color: '#eab308', cry: '【福】幸を置いていくよ' }
      ],
      lines: { intro: '座敷に小さな足音', win: '童は微笑んで消えた', lose: '福が逃げた…' }
    },
    {
      id: 'nekomata',
      name: '猫又',
      title: 'ねこまた',
      motif: '変拍子・尾が二つに裂けた老猫。気まぐれな 5/8 拍',
      unlockLevel: 14,
      isHidden: false,
      isBoss: false,
      reward: { xp: 160, coin: 48, dropChance: 0.63 },
      phases: [{ hp: 416, atk: 26, color: '#a3a3a3', cry: 'ニャーォ…' }],
      lines: { intro: '猫又が尾を振る', win: '猫又は屋根へ消えた', lose: '変拍子に翻弄された…' }
    },
    {
      id: 'kyubi_kitsune',
      name: '九尾狐',
      title: 'きゅうび',
      motif: '魅惑拍・九つの尾を持つ妖狐。誘惑のリズム',
      unlockLevel: 20,
      isHidden: false,
      isBoss: true,
      reward: { xp: 260, coin: 100, dropChance: 0.8 },
      phases: [
        { hp: 504, atk: 28, color: '#f97316', cry: 'コーン…' },
        { hp: 356, atk: 38, color: '#c2410c', cry: '【魅惑】我が拍に酔うがよい' }
      ],
      lines: { intro: '九尾の妖狐が現れる', win: '九尾は霧に消えた', lose: '魅惑拍に呑まれた…' }
    },
    {
      id: 'nurarihyon',
      name: 'ぬらりひょん',
      title: 'ぬらりひょん',
      motif: 'リーダー鬼・隠し。妖怪総大将の貫禄ある拍',
      unlockLevel: 999,
      isHidden: true,
      hiddenCondition: 'defeated_15_uniques', // 15 種類撃破後に出現
      isBoss: true,
      reward: { xp: 600, coin: 260, dropChance: 0.95 },
      phases: [
        { hp: 578, atk: 40, color: '#581c87', cry: 'ふむ…茶でも飲むか' },
        { hp: 433, atk: 54, color: '#3b0764', cry: '【総大将】妖怪共を率いて参った' },
        { hp: 289, atk: 72, color: '#1e0838', cry: '【真総大将】我こそ妖怪の王なり' }
      ],
      lines: { intro: '妖怪の総大将が涼やかに現れる', win: '総大将は煙のように消えた', lose: '貫禄に圧された…' }
    },
    {
      id: 'kamaitachi',
      name: '鎌鼬',
      title: 'かまいたち',
      motif: '速攻3連・つむじ風に乗る三妖。連打の試練',
      unlockLevel: 11,
      isHidden: false,
      isBoss: false,
      reward: { xp: 125, coin: 38, dropChance: 0.62 },
      phases: [
        { hp: 193, atk: 18, color: '#67e8f9', cry: 'シュッ…' },
        { hp: 150, atk: 24, color: '#06b6d4', cry: 'シュッシュッ…' },
        { hp: 107, atk: 32, color: '#0e7490', cry: '【三連】シュシュシュッ！' }
      ],
      lines: { intro: 'つむじ風に三つの影', win: '鎌鼬は風に消えた', lose: '三連に切り刻まれた…' }
    },

    // ---- 海外神話 25 体（B001 推奨 6 + CEO 抽出 19）-------------
    // 文化整合：実名借用は伝承への敬意ある motif で記述・茶化し禁止
    {
      id: 'damaru_shiva',
      name: 'Damaru シヴァ',
      title: 'だまる',
      motif: 'インド・シヴァ神の小太鼓。最初の音とされる創造の拍',
      unlockLevel: 21,
      isHidden: false,
      isBoss: true,
      reward: { xp: 290, coin: 110, dropChance: 0.8 },
      phases: [
        { hp: 518, atk: 30, color: '#7e22ce', cry: 'ダマルが鳴る…' },
        { hp: 374, atk: 40, color: '#581c87', cry: '【最初の音】これが音の始まり' }
      ],
      lines: { intro: '小太鼓の響きが空間を満たす', win: 'ダマルは静まった', lose: '最初の音に飲まれた…' }
    },
    {
      id: 'shango_bata',
      name: 'バタ太鼓シャンゴ',
      title: 'シャンゴ',
      motif: 'ヨルバ・雷神シャンゴの聖楽器バタ太鼓。三体一組の神聖な響き',
      unlockLevel: 17,
      isHidden: false,
      isBoss: false,
      reward: { xp: 175, coin: 54, dropChance: 0.65 },
      phases: [{ hp: 488, atk: 26, color: '#dc2626', cry: 'バタ・バタ…' }],
      lines: { intro: '三つの太鼓が並ぶ', win: '雷は遠ざかった', lose: '雷神の威に打たれた…' }
    },
    {
      id: 'numu_djembe',
      name: 'ジャンベ Numu',
      title: 'ヌム',
      motif: '西アフリカ・鍛冶神ヌムが作りしジャンベ。村を呼ぶ太鼓',
      unlockLevel: 9,
      isHidden: false,
      isBoss: false,
      reward: { xp: 100, coin: 32, dropChance: 0.6 },
      phases: [{ hp: 296, atk: 19, color: '#a16207', cry: 'ドゥン・ドゥン…' }],
      lines: { intro: '村が太鼓で目覚める', win: '太鼓は静まった', lose: '鍛冶の響きに圧された…' }
    },
    {
      id: 'korybantes',
      name: 'Korybantes',
      title: 'コリバンテス',
      motif: 'ギリシャ・盾打ちの守護兵。幼神ゼウスを守った楯の音',
      unlockLevel: 13,
      isHidden: false,
      isBoss: false,
      reward: { xp: 140, coin: 42, dropChance: 0.62 },
      phases: [{ hp: 392, atk: 22, color: '#a8a29e', cry: '盾と剣の打音…' }],
      lines: { intro: '盾打ちの兵が現れる', win: '盾打ちは止んだ', lose: '盾の連打に打ちのめされた…' }
    },
    {
      id: 'sami_goavddis',
      name: 'Sami Goavddis',
      title: 'ゴアッディス',
      motif: '北欧サーミ・シャーマン太鼓。トナカイ皮の聖なる響き',
      unlockLevel: 15,
      isHidden: false,
      isBoss: false,
      reward: { xp: 165, coin: 50, dropChance: 0.62 },
      phases: [{ hp: 440, atk: 24, color: '#475569', cry: 'ドゥム…ドゥム…' }],
      lines: { intro: 'シャーマンが太鼓を構える', win: '儀式は終わった', lose: 'トランスに引き込まれた…' }
    },
    {
      id: 'bantu_conga',
      name: 'コンガ Bantu',
      title: 'バントゥ',
      motif: '中央アフリカ・部族コミュニケーションのコンガ。村の言葉を運ぶ',
      unlockLevel: 7,
      isHidden: false,
      isBoss: false,
      reward: { xp: 85, coin: 26, dropChance: 0.6 },
      phases: [{ hp: 248, atk: 16, color: '#854d0e', cry: 'トン・トン…' }],
      lines: { intro: '村の太鼓が響く', win: '村は安らいだ', lose: '部族拍に呑まれた…' }
    },
    {
      id: 'thor',
      name: 'Thor',
      title: 'トール',
      motif: '北欧雷神・ハンマー Mjölnir の重撃。雷鳴の重低音',
      unlockLevel: 28,
      isHidden: false,
      isBoss: true,
      reward: { xp: 460, coin: 190, dropChance: 0.85 },
      phases: [
        { hp: 622, atk: 38, color: '#b91c1c', cry: 'Mjölnir が唸る…' },
        { hp: 467, atk: 50, color: '#7f1d1d', cry: '【雷神】我が槌は雷を呼ぶ' },
        { hp: 311, atk: 68, color: '#450a0a', cry: '【真雷神】Þórr！' }
      ],
      lines: { intro: '雷神の槌が天を裂く', win: '雷神は雲へ帰った', lose: 'Mjölnir に打ち砕かれた…' }
    },
    {
      id: 'dionysos',
      name: 'Dionysos',
      title: 'ディオニュソス',
      motif: 'ギリシャ・狂乱拍ボス。酒と陶酔の神。テュンパノンの乱拍',
      unlockLevel: 23,
      isHidden: false,
      isBoss: true,
      reward: { xp: 310, coin: 120, dropChance: 0.8 },
      phases: [
        { hp: 550, atk: 30, color: '#7e22ce', cry: '葡萄酒の杯が傾く…' },
        { hp: 406, atk: 40, color: '#581c87', cry: '【狂乱】拍に酔え、踊り狂え' }
      ],
      lines: { intro: '酒神の祭が始まる', win: '祭は鎮まった', lose: '狂乱に巻き込まれた…' }
    },
    {
      id: 'pan',
      name: 'Pan',
      title: 'パン',
      motif: 'ギリシャ・パンパイプの牧神。森の旋律と拍',
      unlockLevel: 10,
      isHidden: false,
      isBoss: false,
      reward: { xp: 110, coin: 34, dropChance: 0.6 },
      phases: [{ hp: 320, atk: 18, color: '#65a30d', cry: 'ピィー…' }],
      lines: { intro: '森に笛の音', win: '牧神は森へ消えた', lose: 'パンの旋律に魅せられた…' }
    },
    {
      id: 'tlaloc',
      name: 'Tlaloc',
      title: 'トラロック',
      motif: 'アステカ雷神・雨と雷の神。重い水滴の連打',
      unlockLevel: 31,
      isHidden: false,
      isBoss: true,
      reward: { xp: 540, coin: 220, dropChance: 0.85 },
      phases: [
        { hp: 681, atk: 40, color: '#1e3a8a', cry: '雨が地を打つ…' },
        { hp: 498, atk: 54, color: '#172554', cry: '【豪雨】雨拍は止まぬ' },
        { hp: 341, atk: 72, color: '#0c0a47', cry: '【真雷神】我は雨と雷の主' }
      ],
      lines: { intro: '雨と雷の神が降臨', win: '雨は上がった', lose: '豪雨に飲まれた…' }
    },
    {
      id: 'quetzalcoatl',
      name: 'Quetzalcoatl',
      title: 'ケツァルコアトル',
      motif: 'メソアメリカ・羽蛇王。風と知恵の神。羽ばたきの拍',
      unlockLevel: 24,
      isHidden: false,
      isBoss: true,
      reward: { xp: 330, coin: 130, dropChance: 0.82 },
      phases: [
        { hp: 569, atk: 30, color: '#16a34a', cry: '羽蛇の風…' },
        { hp: 419, atk: 42, color: '#15803d', cry: '【羽蛇王】我は風と知恵の主' }
      ],
      lines: { intro: '羽蛇王が空を巡る', win: '羽蛇は天へ昇った', lose: '羽の風に巻かれた…' }
    },
    {
      id: 'tezcatlipoca',
      name: 'Tezcatlipoca',
      title: 'テスカトリポカ',
      motif: 'メソアメリカ・煙鏡の夜の神。トリックスター大ボス',
      unlockLevel: 33,
      isHidden: false,
      isBoss: true,
      reward: { xp: 600, coin: 260, dropChance: 0.88 },
      phases: [
        { hp: 708, atk: 42, color: '#1f2937', cry: '黒曜の鏡が光る…' },
        { hp: 525, atk: 56, color: '#111827', cry: '【煙鏡】我が姿は映らぬ' },
        { hp: 367, atk: 76, color: '#030712', cry: '【夜の主】闇の拍を浴びよ' }
      ],
      lines: { intro: '煙鏡の神が現れる', win: '煙鏡は曇った', lose: '夜の拍に飲まれた…' }
    },
    {
      id: 'bes',
      name: 'Bes',
      title: 'ベス',
      motif: 'エジプト・タンバリン神。家庭と音楽を守る陽気な小神',
      unlockLevel: 5,
      isHidden: false,
      isBoss: false,
      reward: { xp: 70, coin: 22, dropChance: 0.58 },
      phases: [{ hp: 200, atk: 12, color: '#fbbf24', cry: 'シャラン…' }],
      lines: { intro: '陽気なタンバリンが響く', win: 'ベスは笑って消えた', lose: '陽気な拍に乗せられた…' }
    },
    {
      id: 'bastet',
      name: 'Bastet',
      title: 'バステト',
      motif: 'エジプト・猫の女神。シストルムの装飾拍',
      unlockLevel: 12,
      isHidden: false,
      isBoss: false,
      reward: { xp: 135, coin: 42, dropChance: 0.62 },
      phases: [{ hp: 368, atk: 22, color: '#facc15', cry: 'シャリン…' }],
      lines: { intro: '猫の女神が現れる', win: '女神は静かに去った', lose: 'シストルムに惑わされた…' }
    },
    {
      id: 'anubis',
      name: 'Anubis',
      title: 'アヌビス',
      motif: 'エジプト・冥拍の番人。死者の魂を導く厳粛な拍',
      unlockLevel: 999,
      isHidden: true,
      hiddenCondition: 'late_night_50', // 深夜練習 50 回以上
      isBoss: true,
      reward: { xp: 540, coin: 220, dropChance: 0.92 },
      phases: [
        { hp: 649, atk: 38, color: '#1f2937', cry: '冥界の秤が鳴る…' },
        { hp: 451, atk: 52, color: '#111827', cry: '【秤量】お前の魂を量らん' }
      ],
      lines: { intro: '冥界の番人が現れる', win: '魂は受け入れられた', lose: '冥拍に導かれた…' }
    },
    {
      id: 'eshu',
      name: 'Eshu',
      title: 'エシュ',
      motif: 'ヨルバ・分岐拍。境界とコミュニケーションを司る伝令神',
      unlockLevel: 8,
      isHidden: false,
      isBoss: false,
      reward: { xp: 92, coin: 28, dropChance: 0.6 },
      phases: [{ hp: 272, atk: 17, color: '#dc2626', cry: 'カチ…カチ…' }],
      lines: { intro: '境界の神が現れる', win: '境界は閉じた', lose: '分岐に迷い込んだ…' }
    },
    {
      id: 'anansi',
      name: 'Anansi',
      title: 'アナンシ',
      motif: 'アカン・パターン蜘蛛。物語と知恵を編む蜘蛛神',
      unlockLevel: 14,
      isHidden: false,
      isBoss: false,
      reward: { xp: 155, coin: 46, dropChance: 0.63 },
      phases: [{ hp: 416, atk: 23, color: '#52525b', cry: '糸を編む音…' }],
      lines: { intro: '蜘蛛神が糸を張る', win: '糸は解けた', lose: 'パターンに絡め取られた…' }
    },
    {
      id: 'oya',
      name: 'Oya',
      title: 'オヤ',
      motif: 'ヨルバ風神・嵐と変化の女神。突風の拍',
      unlockLevel: 16,
      isHidden: false,
      isBoss: false,
      reward: { xp: 175, coin: 56, dropChance: 0.65 },
      phases: [{ hp: 464, atk: 26, color: '#a855f7', cry: '突風が吹き抜ける…' }],
      lines: { intro: '嵐の女神が現れる', win: '嵐は静まった', lose: '突風に飛ばされた…' }
    },
    {
      id: 'mami_wata',
      name: 'Mami Wata',
      title: 'マミワタ',
      motif: '西アフリカ水神・大海の女神。波打つ大ボス。畏敬の念で扱う',
      unlockLevel: 34,
      isHidden: false,
      isBoss: true,
      reward: { xp: 620, coin: 270, dropChance: 0.88 },
      phases: [
        { hp: 726, atk: 42, color: '#0e7490', cry: '海の囁きが響く…' },
        { hp: 538, atk: 56, color: '#155e75', cry: '【満潮】波が押し寄せる' },
        { hp: 376, atk: 76, color: '#083344', cry: '【大海】我は水の母なり' }
      ],
      lines: { intro: '水の女神が海から立ち上る', win: '水は静まった', lose: '大海に呑まれた…' }
    },
    {
      id: 'loki',
      name: 'Loki',
      title: 'ロキ',
      motif: '北欧・トリック拍。変化の神。予測不能な変則拍',
      unlockLevel: 18,
      isHidden: false,
      isBoss: false,
      reward: { xp: 200, coin: 64, dropChance: 0.65 },
      phases: [
        { hp: 385, atk: 24, color: '#15803d', cry: 'クッ…ククッ' },
        { hp: 275, atk: 32, color: '#166534', cry: '【変化】拍は変わるさ、いつも' }
      ],
      lines: { intro: 'トリックスターが微笑む', win: 'ロキは姿を変えて消えた', lose: '変則拍に翻弄された…' }
    },
    {
      id: 'bragi',
      name: 'Bragi',
      title: 'ブラギ',
      motif: '北欧・詩拍の神。吟遊の調べと拍を司る',
      unlockLevel: 11,
      isHidden: false,
      isBoss: false,
      reward: { xp: 120, coin: 38, dropChance: 0.6 },
      phases: [{ hp: 344, atk: 20, color: '#0891b2', cry: '弦が鳴る…' }],
      lines: { intro: '詩神が竪琴を奏でる', win: '詩は紡がれた', lose: '吟遊に魅せられた…' }
    },
    {
      id: 'cernunnos',
      name: 'Cernunnos',
      title: 'ケルヌンノス',
      motif: 'ケルト・鹿角の神。森と動物の拍',
      unlockLevel: 13,
      isHidden: false,
      isBoss: false,
      reward: { xp: 145, coin: 44, dropChance: 0.62 },
      phases: [{ hp: 392, atk: 22, color: '#65a30d', cry: '森が呼応する…' }],
      lines: { intro: '鹿角の神が現れる', win: '森は静まった', lose: '森の拍に呑まれた…' }
    },
    {
      id: 'brigid',
      name: 'Brigid',
      title: 'ブリギッド',
      motif: 'ケルト・鍛冶と詩の女神。炎の鍛冶拍',
      unlockLevel: 15,
      isHidden: false,
      isBoss: false,
      reward: { xp: 165, coin: 50, dropChance: 0.62 },
      phases: [{ hp: 440, atk: 24, color: '#ea580c', cry: '鍛冶の槌音…' }],
      lines: { intro: '鍛冶神が炉に立つ', win: '炉は冷えた', lose: '鍛冶拍に焼かれた…' }
    },
    {
      id: 'pele',
      name: 'Pele',
      title: 'ペレ',
      motif: 'ハワイ・火山の女神。溶岩の脈動。畏敬を込めた重低音',
      unlockLevel: 27,
      isHidden: false,
      isBoss: true,
      reward: { xp: 400, coin: 160, dropChance: 0.82 },
      phases: [
        { hp: 619, atk: 32, color: '#dc2626', cry: '溶岩が脈打つ…' },
        { hp: 465, atk: 44, color: '#991b1b', cry: '【噴火】火山の女神は怒れり' }
      ],
      lines: { intro: '火山の女神が立ち上る', win: '溶岩は鎮まった', lose: '噴火に飲まれた…' }
    },
    {
      id: 'kupala',
      name: 'Kupala',
      title: 'クパーラ',
      motif: 'スラヴ・夏至拍の女神・隠し。夏至の夜の篝火と踊り',
      unlockLevel: 999,
      isHidden: true,
      hiddenCondition: 'streak_30', // 30 日連続練習で出現
      isBoss: false,
      reward: { xp: 350, coin: 130, dropChance: 0.88 },
      phases: [
        { hp: 418, atk: 30, color: '#f59e0b', cry: '夏至の篝火…' },
        { hp: 302, atk: 42, color: '#b45309', cry: '【夏至】祝祭の夜は終わらぬ' }
      ],
      lines: { intro: '夏至の女神が篝火を灯す', win: '篝火は静まった', lose: '祝祭に巻き込まれた…' }
    }
  ];

  // -------------------------------------------------------------
  // 2. 称号テーブル（30 件・解禁条件は GameState 監査で評価）
  // -------------------------------------------------------------
  var TITLES = [
    { id: 't_first_blood',     name: '初撃破',        check: function (s) { return s.wins >= 1; } },
    { id: 't_three_kills',     name: '三体討伐',      check: function (s) { return s.wins >= 3; } },
    { id: 't_ten_kills',       name: '十体討伐',      check: function (s) { return s.wins >= 10; } },
    { id: 't_thirty_kills',    name: '三十体討伐',    check: function (s) { return s.wins >= 30; } },
    { id: 't_hundred_kills',   name: '百体討伐',      check: function (s) { return s.wins >= 100; } },
    { id: 't_lvl5',            name: '初段（Lv5）',   check: function (s) { return s.level >= 5; } },
    { id: 't_lvl10',           name: '中段（Lv10）',  check: function (s) { return s.level >= 10; } },
    { id: 't_lvl20',           name: '上段（Lv20）',  check: function (s) { return s.level >= 20; } },
    { id: 't_lvl50',           name: '皆伝（Lv50）',  check: function (s) { return s.level >= 50; } },
    { id: 't_8_clear',         name: '八体制覇',      check: function (s) { return Object.keys(s.defeated || {}).length >= 8; } },
    { id: 't_haku_gami',       name: '拍を超えた者',  check: function (s) { return !!(s.defeated && s.defeated.haku_gami); } },
    { id: 't_thunder',         name: '雷を制した者',  check: function (s) { return !!(s.defeated && s.defeated.thunder_drum); } },
    { id: 't_miko',            name: '舞を読み解く者',check: function (s) { return !!(s.defeated && s.defeated.rhythm_miko); } },
    { id: 't_yamata',          name: '八叉討ち',      check: function (s) { return !!(s.defeated && s.defeated.eight_drum); } },
    { id: 't_kusanagi',        name: '神剣の使い手',  check: function (s) { return !!(s.defeated && s.defeated.kusanagi_snare); } },
    { id: 't_amatsu',          name: '始祖の継承者',  check: function (s) { return !!(s.defeated && s.defeated.amatsu_drummer); } },
    { id: 't_streak_demon',    name: '継続の鬼を倒す',check: function (s) { return !!(s.defeated && s.defeated.streak_demon); } },
    { id: 't_shadow',          name: '夜の探索者',    check: function (s) { return !!(s.defeated && s.defeated.midnight_shadow); } },
    { id: 't_wind_shaker',     name: '風神を制した者',check: function (s) { return !!(s.defeated && s.defeated.wind_shaker); } },
    { id: 't_tsukuyomi_click', name: '月読の刻みを破りし者',check: function (s) { return !!(s.defeated && s.defeated.tsukuyomi_click); } },
    { id: 't_dmg_100',         name: '100ダメージ',   check: function (s) { return (s.records && s.records.bestDamage) >= 100; } },
    { id: 't_dmg_500',         name: '500ダメージ',   check: function (s) { return (s.records && s.records.bestDamage) >= 500; } },
    { id: 't_streak_5',        name: '5連勝',         check: function (s) { return (s.records && s.records.longestStreak) >= 5; } },
    { id: 't_streak_10',       name: '10連勝',        check: function (s) { return (s.records && s.records.longestStreak) >= 10; } },
    { id: 't_coins_100',       name: '小金持ち',      check: function (s) { return (s.coins || 0) >= 100; } },
    { id: 't_coins_1000',      name: '大金持ち',      check: function (s) { return (s.coins || 0) >= 1000; } },
    { id: 't_equip_5',         name: '装備 5 個',     check: function (s) { return (s.equipment || []).length >= 5; } },
    { id: 't_equip_rare4',     name: '★4 入手',      check: function (s) { return (s.equipment || []).some(function (e) { return e.rarity >= 4; }); } },
    { id: 't_equip_rare5',     name: '★5 伝説装備',  check: function (s) { return (s.equipment || []).some(function (e) { return e.rarity >= 5; }); } },
    { id: 't_prestige_1',      name: 'プレステ I',    check: function (s) { return (s.prestige || 0) >= 1; } },
    { id: 't_prestige_3',      name: 'プレステ III',  check: function (s) { return (s.prestige || 0) >= 3; } },
    { id: 't_battles_100',     name: '百戦錬磨',      check: function (s) { return (s.battlesPlayed || 0) >= 100; } },
    // ---------------------------------------------------------------
    // SS-2 拡張：新規 50 体撃破称号 + 種類制覇 3 件（合計 +53 件 / TITLES 30 → 83）
    // 命名規則：t_<enemy_id> snake_case 既存 8 体撃破称号と整合
    // 文化整合：海外 25 体は敬意ある motif（討伐者表現を避け「鎮めし者／謁見者／継承者」等で表現）
    // ---------------------------------------------------------------
    // 日本神話メイン 15 体（Kojiki 系）
    { id: 't_susanoo',          name: '須佐之男討伐者',      check: function (s) { return !!(s.defeated && s.defeated.susanoo); } },
    { id: 't_ame_no_uzume_alt', name: '天宇受売別態を読みし者', check: function (s) { return !!(s.defeated && s.defeated.ame_no_uzume_alt); } },
    { id: 't_tsukuyomi_no_mikoto', name: '月夜見尊と並びし者', check: function (s) { return !!(s.defeated && s.defeated.tsukuyomi_no_mikoto); } },
    { id: 't_izanagi',          name: '伊弉諾を超えし者',    check: function (s) { return !!(s.defeated && s.defeated.izanagi); } },
    { id: 't_izanami',          name: '伊弉冉を弔いし者',    check: function (s) { return !!(s.defeated && s.defeated.izanami); } },
    { id: 't_sukunabikona',     name: '少名毘古那を捉えし者', check: function (s) { return !!(s.defeated && s.defeated.sukunabikona); } },
    { id: 't_watatsumi',        name: '海神綿津見を鎮めし者', check: function (s) { return !!(s.defeated && s.defeated.watatsumi); } },
    { id: 't_sarutahiko',       name: '猿田彦を導きし者',    check: function (s) { return !!(s.defeated && s.defeated.sarutahiko); } },
    { id: 't_amenotajikarao',   name: '天手力男と力比べせし者', check: function (s) { return !!(s.defeated && s.defeated.amenotajikarao); } },
    { id: 't_ookuninushi',      name: '大国主を継ぎし者',    check: function (s) { return !!(s.defeated && s.defeated.ookuninushi); } },
    { id: 't_takemikazuchi',    name: '建御雷を制せし者',    check: function (s) { return !!(s.defeated && s.defeated.takemikazuchi); } },
    { id: 't_oyamatsumi',       name: '大山祇を鎮めし者',    check: function (s) { return !!(s.defeated && s.defeated.oyamatsumi); } },
    { id: 't_konohanasakuya',   name: '木花咲耶姫を解きし者', check: function (s) { return !!(s.defeated && s.defeated.konohanasakuya); } },
    { id: 't_yamatotakeru',     name: '倭建命と並走せし者',  check: function (s) { return !!(s.defeated && s.defeated.yamatotakeru); } },
    { id: 't_omononushi',       name: '大物主の蛇紋を解きし者', check: function (s) { return !!(s.defeated && s.defeated.omononushi); } },
    // 民俗・妖怪 10 体
    { id: 't_kappa',            name: '河童討伐者',          check: function (s) { return !!(s.defeated && s.defeated.kappa); } },
    { id: 't_tengu',            name: '天狗討伐者',          check: function (s) { return !!(s.defeated && s.defeated.tengu); } },
    { id: 't_yamauba',          name: '山姥退治',            check: function (s) { return !!(s.defeated && s.defeated.yamauba); } },
    { id: 't_shutendoji',       name: '酒呑童子討伐者',      check: function (s) { return !!(s.defeated && s.defeated.shutendoji); } },
    { id: 't_nue',              name: '鵺を射抜きし者',      check: function (s) { return !!(s.defeated && s.defeated.nue); } },
    { id: 't_zashiki_warashi',  name: '座敷童と遊びし者',    check: function (s) { return !!(s.defeated && s.defeated.zashiki_warashi); } },
    { id: 't_nekomata',         name: '猫又退治',            check: function (s) { return !!(s.defeated && s.defeated.nekomata); } },
    { id: 't_kyubi_kitsune',    name: '九尾狐討伐者',        check: function (s) { return !!(s.defeated && s.defeated.kyubi_kitsune); } },
    { id: 't_nurarihyon',       name: 'ぬらりひょんを見送りし者', check: function (s) { return !!(s.defeated && s.defeated.nurarihyon); } },
    { id: 't_kamaitachi',       name: '鎌鼬を捉えし者',      check: function (s) { return !!(s.defeated && s.defeated.kamaitachi); } },
    // 海外神話 25 体（敬意あるトーン・討伐表現を避け「鎮める／謁見／継承／対話」等で表現）
    { id: 't_damaru_shiva',     name: 'Damaru シヴァを鎮めし者',     check: function (s) { return !!(s.defeated && s.defeated.damaru_shiva); } },
    { id: 't_shango_bata',      name: 'シャンゴに敬意を捧げし者',    check: function (s) { return !!(s.defeated && s.defeated.shango_bata); } },
    { id: 't_numu_djembe',      name: 'Numu の鍛冶拍を継ぎし者',     check: function (s) { return !!(s.defeated && s.defeated.numu_djembe); } },
    { id: 't_korybantes',       name: 'Korybantes と盾を打ちし者',   check: function (s) { return !!(s.defeated && s.defeated.korybantes); } },
    { id: 't_sami_goavddis',    name: 'Sami Goavddis に学びし者',    check: function (s) { return !!(s.defeated && s.defeated.sami_goavddis); } },
    { id: 't_bantu_conga',      name: 'Bantu の部族拍を継ぎし者',    check: function (s) { return !!(s.defeated && s.defeated.bantu_conga); } },
    { id: 't_thor',             name: 'Thor の槌に応えし者',         check: function (s) { return !!(s.defeated && s.defeated.thor); } },
    { id: 't_dionysos',         name: 'Dionysos の狂宴を抜けし者',   check: function (s) { return !!(s.defeated && s.defeated.dionysos); } },
    { id: 't_pan',              name: 'Pan の笛を聴き取りし者',      check: function (s) { return !!(s.defeated && s.defeated.pan); } },
    { id: 't_tlaloc',           name: 'Tlaloc の雷雨を耐えし者',     check: function (s) { return !!(s.defeated && s.defeated.tlaloc); } },
    { id: 't_quetzalcoatl',     name: 'Quetzalcoatl に謁見せし者',   check: function (s) { return !!(s.defeated && s.defeated.quetzalcoatl); } },
    { id: 't_tezcatlipoca',     name: 'Tezcatlipoca の鏡を返せし者', check: function (s) { return !!(s.defeated && s.defeated.tezcatlipoca); } },
    { id: 't_bes',              name: 'Bes と踊りし者',              check: function (s) { return !!(s.defeated && s.defeated.bes); } },
    { id: 't_bastet',           name: 'Bastet と歩を合わせし者',     check: function (s) { return !!(s.defeated && s.defeated.bastet); } },
    { id: 't_anubis',           name: 'Anubis に裁かれざる者',       check: function (s) { return !!(s.defeated && s.defeated.anubis); } },
    { id: 't_eshu',             name: 'Eshu の分岐を読みし者',       check: function (s) { return !!(s.defeated && s.defeated.eshu); } },
    { id: 't_anansi',           name: 'Anansi の織り目を解きし者',   check: function (s) { return !!(s.defeated && s.defeated.anansi); } },
    { id: 't_oya',              name: 'Oya の風に抗いし者',          check: function (s) { return !!(s.defeated && s.defeated.oya); } },
    { id: 't_mami_wata',        name: 'Mami Wata に敬意を捧げし者',  check: function (s) { return !!(s.defeated && s.defeated.mami_wata); } },
    { id: 't_loki',             name: 'Loki の罠を見破りし者',       check: function (s) { return !!(s.defeated && s.defeated.loki); } },
    { id: 't_bragi',            name: 'Bragi の詩に応えし者',        check: function (s) { return !!(s.defeated && s.defeated.bragi); } },
    { id: 't_cernunnos',        name: 'Cernunnos と森を歩みし者',    check: function (s) { return !!(s.defeated && s.defeated.cernunnos); } },
    { id: 't_brigid',           name: 'Brigid の鍛冶火を継ぎし者',   check: function (s) { return !!(s.defeated && s.defeated.brigid); } },
    { id: 't_pele',             name: 'Pele に敬意を捧げし者',       check: function (s) { return !!(s.defeated && s.defeated.pele); } },
    { id: 't_kupala',           name: 'Kupala の夏至を超えし者',     check: function (s) { return !!(s.defeated && s.defeated.kupala); } },
    // 段階制ボーナス称号（種類制覇・既存 t_8_clear と重複しない範囲で追加）
    // 既存：t_8_clear（8 種類撃破）／t_first_blood〜t_hundred_kills（撃破回数）。
    // 「10 体撃破」は既存 t_ten_kills（s.wins>=10）と命名衝突するため除外。
    { id: 't_25_clear',         name: '二十五体制覇',        check: function (s) { return Object.keys(s.defeated || {}).length >= 25; } },
    { id: 't_50_clear',         name: '五十体制覇',          check: function (s) { return Object.keys(s.defeated || {}).length >= 50; } },
    { id: 't_60_clear',         name: '六十体完全制覇',      check: function (s) { return Object.keys(s.defeated || {}).length >= 60; } }
  ];

  // -------------------------------------------------------------
  // 3. 装備生成テーブル
  // -------------------------------------------------------------
  // rarity: 1=N, 2=R, 3=SR, 4=SSR, 5=UR
  var RARITY_LABEL = ['', 'N', 'R', 'SR', 'SSR', 'UR'];
  var RARITY_COLOR = ['', '#9ca3af', '#3b82f6', '#a855f7', '#f59e0b', '#ef4444'];
  var RARITY_DROP_TABLE = [
    // [r, weight] — gacha 用（基準）。rare は重くした重み
    [1, 50], [2, 30], [3, 14], [4, 5], [5, 1]
  ];
  // SS-4 装備スロット 3-5 可変解禁
  // - 'acc' は v3.2.0 までの単一アクセスロット → v3.3.0 で 'acc1' / 'acc2' / 'acc3' へ分岐
  // - acc1: Lv 1 解禁（既存 'acc' スロットの後継・migration 対象）
  // - acc2: Lv 10 解禁
  // - acc3: Lv 20 解禁
  // - 装備の slot 値の前方互換は loadState() / dropEquipment() / makeEquipment() で吸収
  var EQUIP_NAMES = {
    weapon:  ['修練のスティック', '雷紋ドラムスティック', '神鳴り棒', '八岐ロッド', '創世スティック'],
    armor:   ['練習着', '皮の前掛け', '鼓動の胴当て', '響鎧', '神衣'],
    acc1:    ['調律ブレス', 'メトロブレス', '拍守りの数珠', '神楽の鈴', '創始の冠'],
    acc2:    ['速拍リング', '残響イヤカフ', '律動の腕輪', '神鳴の指輪', '太古の耳飾り'],
    acc3:    ['共振の護符', '深淵タリスマン', '時拍ロケット', '創世の宝玉', '神格メダリオン']
  };
  // 旧 'acc' 名称テーブル（migration / 旧 itemId rarity フォールバック用）
  EQUIP_NAMES.acc = EQUIP_NAMES.acc1;
  var SLOTS = ['weapon', 'armor', 'acc1', 'acc2', 'acc3'];
  var SLOT_UNLOCK_LV = { weapon: 1, armor: 1, acc1: 1, acc2: 10, acc3: 20 };
  var SLOT_LABEL = { weapon: '武器', armor: '防具', acc: 'アクセ', acc1: 'アクセ 1', acc2: 'アクセ 2', acc3: 'アクセ 3' };

  // SS-4 ヘルパ：Lv に応じた解禁スロット配列を返す
  function unlockedSlots(level) {
    var lv = (typeof level === 'number' && level >= 1) ? level : 1;
    return SLOTS.filter(function (s) { return (SLOT_UNLOCK_LV[s] || 1) <= lv; });
  }

  function pickRarityWeighted() {
    var total = RARITY_DROP_TABLE.reduce(function (s, x) { return s + x[1]; }, 0);
    var r = Math.random() * total;
    for (var i = 0; i < RARITY_DROP_TABLE.length; i++) {
      r -= RARITY_DROP_TABLE[i][1];
      if (r <= 0) return RARITY_DROP_TABLE[i][0];
    }
    return 1;
  }

  function makeEquipment(slot, rarity) {
    if (!slot) slot = SLOTS[Math.floor(Math.random() * SLOTS.length)];
    // 旧 'acc' 引数は 'acc1' へ正規化（migration 後に直接呼ばれた場合の保険）
    if (slot === 'acc') slot = 'acc1';
    if (!rarity) rarity = pickRarityWeighted();
    var nameArr = EQUIP_NAMES[slot] || EQUIP_NAMES.weapon;
    var name = nameArr[Math.min(rarity - 1, nameArr.length - 1)];
    var atk = 0, hp = 0, acc = 0;
    var base = rarity * rarity * 2; // 2,8,18,32,50
    if (slot === 'weapon') { atk = base + 2; acc = Math.round(base * 0.1); }
    else if (slot === 'armor') { hp = base * 3 + 5; }
    else { acc = Math.round(base * 0.4); atk = Math.round(base * 0.3); }
    return {
      id: 'eq_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 999),
      name: name,
      slot: slot,
      rarity: rarity,
      atk: atk, hp: hp, acc: acc,
      dropAt: Date.now()
    };
  }

  // -------------------------------------------------------------
  // 4. State I/O
  // -------------------------------------------------------------
  function loadState() {
    var s = lsGet(LS_KEY, null);
    if (!s || typeof s !== 'object') {
      s = {
        schema_version: 1,
        xp: 0, coins: 0, level: 1, prestige: 0,
        equipment: [], titles: [], defeated: {},
        records: { bestDamage: 0, fastestWinMs: null, longestStreak: 0, currentStreak: 0 },
        lastChargeAt: null, battlesPlayed: 0, wins: 0, losses: 0,
        // SS-1.5 隠し 4 体 hiddenCondition 用 field（本格 migration は SS-8 担当）
        loseStreak: 0,
        lateNightDefeats: 0,
        // SS-3 週替り挑戦 履歴（本格 migration は SS-8 担当）
        weeklyHistory: [],
        // SS-6 装備分解→還元星循環ループ（本格 migration は SS-8 担当）
        stars: 0
      };
    }
    // schema migration（前方互換）
    if (!s.records) s.records = { bestDamage: 0, fastestWinMs: null, longestStreak: 0, currentStreak: 0 };
    if (!s.equipment) s.equipment = [];
    if (!s.titles) s.titles = [];
    if (!s.defeated) s.defeated = {};
    if (typeof s.prestige !== 'number') s.prestige = 0;
    if (typeof s.battlesPlayed !== 'number') s.battlesPlayed = 0;
    if (typeof s.wins !== 'number') s.wins = 0;
    if (typeof s.losses !== 'number') s.losses = 0;
    // SS-1.5 隠し 4 体 hiddenCondition 用 field（本格 migration は SS-8 担当）
    if (typeof s.loseStreak !== 'number') s.loseStreak = 0;
    if (typeof s.lateNightDefeats !== 'number') s.lateNightDefeats = 0;
    // SS-3 週替り挑戦 履歴
    if (!Array.isArray(s.weeklyHistory)) s.weeklyHistory = [];
    // SS-6 装備分解→還元星循環ループ（本格 migration は SS-8 担当）
    if (typeof s.stars !== 'number') s.stars = 0;
    // SS-4 装備スロット 3-5 化に伴う前方互換 migration（軽量・本格 schema bump は SS-8 担当）
    // 旧 schema：装備の slot は 'weapon' / 'armor' / 'acc' の 3 種
    // 新 schema：'acc' を 'acc1' に再ラベル（既存の equipped 状態・rarity・params・id は完全保持）
    if (Array.isArray(s.equipment)) {
      s.equipment.forEach(function (e) {
        if (e && e.slot === 'acc') e.slot = 'acc1';
      });
    }
    return s;
  }
  function saveState(s) { lsSet(LS_KEY, s); }

  // -------------------------------------------------------------
  // 5. レベル算出（XP→Lv）
  // -------------------------------------------------------------
  // Lv n に必要な累計 XP = 50 * n^1.6
  function levelForXp(xp) {
    var lv = 1;
    while (50 * Math.pow(lv + 1, 1.6) <= xp) lv++;
    return lv;
  }
  function xpToNextLevel(state) {
    var lv = state.level || 1;
    var nextReq = Math.floor(50 * Math.pow(lv + 1, 1.6));
    return Math.max(0, nextReq - (state.xp || 0));
  }

  // -------------------------------------------------------------
  // 6. プレイヤー基礎ステ算出（XP/Lv + 装備合算 + プレステ補正）
  // -------------------------------------------------------------
  function computePlayerStats(state) {
    var lv = state.level || 1;
    var prestigeMul = 1 + (state.prestige || 0) * 0.15;
    var baseHp = (40 + lv * 10) * prestigeMul;
    var baseAtk = (8 + lv * 1.6) * prestigeMul;
    var baseAcc = 80; // %
    (state.equipment || []).forEach(function (e) {
      if (!e || !e.equipped) return; // equipped のみ加算
      baseHp += e.hp || 0;
      baseAtk += e.atk || 0;
      baseAcc += e.acc || 0;
    });
    return {
      hp: Math.round(baseHp),
      atk: Math.round(baseAtk),
      acc: Math.min(99, Math.round(baseAcc))
    };
  }

  // -------------------------------------------------------------
  // 7. XP / コイン獲得
  // -------------------------------------------------------------
  var XP_GAIN = { perBattleWinBase: 10, perPracticeSec30: 5 };
  function gainXP(state, amount) {
    if (!amount || amount < 0) return state;
    state.xp = (state.xp || 0) + amount;
    var newLv = levelForXp(state.xp);
    if (newLv > (state.level || 1)) state.level = newLv;
    return state;
  }
  function gainCoins(state, amount) {
    if (!amount || amount < 0) return state;
    state.coins = (state.coins || 0) + amount;
    return state;
  }

  // -------------------------------------------------------------
  // 8. 練習充電 hook
  //   emolab 編集禁止 → SteadyUseLog（read-only）の getDailyUseCount(7) から
  //   直近の duration_ms を XP/コインに換算（30 秒練習 = XP 5 + コイン 2）
  //   chargeFromPractice は冪等（lastChargeAt 以降の差分のみ反映）
  // -------------------------------------------------------------
  function chargeFromPractice() {
    var state = loadState();
    if (!global.SteadyUseLog || typeof global.SteadyUseLog.getDailyUseCount !== 'function') {
      return { ok: false, reason: 'SteadyUseLog unavailable', xp: 0, coins: 0 };
    }
    var since = state.lastChargeAt || 0;
    // 直近 14 日の合計を計算（バトル直前の充電として運用）
    var rows = [];
    try { rows = global.SteadyUseLog.getDailyUseCount(14) || []; } catch (_) {}
    var totalMs = 0;
    rows.forEach(function (r) {
      // 簡易：date が since 日以降ならカウント。粒度は日単位。
      if (!r) return;
      var dt = r.date ? Date.parse(r.date + 'T00:00:00') : 0;
      if (dt >= since) totalMs += (r.duration_ms || 0);
    });
    var sec = Math.floor(totalMs / 1000);
    var addXp = Math.floor(sec / 30) * XP_GAIN.perPracticeSec30;
    var addCoin = Math.floor(sec / 30) * 2;
    if (addXp > 0) gainXP(state, addXp);
    if (addCoin > 0) gainCoins(state, addCoin);
    state.lastChargeAt = Date.now();
    saveState(state);
    return { ok: true, secCharged: sec, xp: addXp, coins: addCoin };
  }

  // -------------------------------------------------------------
  // 9. 装備ドロップ
  // -------------------------------------------------------------
  function dropEquipment(state, enemy) {
    var chance = (enemy && enemy.reward && enemy.reward.dropChance) || 0.5;
    if (Math.random() > chance) return null;
    // ボスなら rarity ↑（+1 補正）
    var rarity = pickRarityWeighted();
    if (enemy && enemy.isBoss && rarity < 5 && Math.random() < 0.5) rarity++;
    // SS-4 解禁済みスロットからのみドロップ（未解禁 acc2 / acc3 はドロップしない）
    var pool = unlockedSlots(state && state.level);
    var slot = pool[Math.floor(Math.random() * pool.length)] || 'weapon';
    var eq = makeEquipment(slot, rarity);
    state.equipment = state.equipment || [];
    state.equipment.push(eq);
    return eq;
  }

  // -------------------------------------------------------------
  // 10. ガチャ
  //   SS-6（v3.3.0）：通貨選択式（コイン or 還元星）
  //   - GACHA_COST 30 で「コイン 30」or「還元星 30」のいずれか
  //   - 後方互換：gachaRoll(times) の単一引数呼び出しは従来通りコイン消費
  //   - 新形式：gachaRoll(times, 'stars') で還元星消費／'coins' 明示も可
  // -------------------------------------------------------------
  var GACHA_COST = 30; // コイン/1 回 or 還元星/1 回
  function gachaRoll(times, currency) {
    times = times || 1;
    currency = currency === 'stars' ? 'stars' : 'coins'; // 既定はコイン（後方互換）
    var state = loadState();
    var results = [];
    // SS-4 ガチャも解禁済みスロットからのみ排出（Lv 連動）
    var pool = unlockedSlots(state && state.level);
    for (var i = 0; i < times; i++) {
      if (currency === 'stars') {
        if ((state.stars || 0) < GACHA_COST) break;
        state.stars -= GACHA_COST;
      } else {
        if ((state.coins || 0) < GACHA_COST) break;
        state.coins -= GACHA_COST;
      }
      var rarity = pickRarityWeighted();
      var slot = pool[Math.floor(Math.random() * pool.length)] || 'weapon';
      var eq = makeEquipment(slot, rarity);
      state.equipment = state.equipment || [];
      state.equipment.push(eq);
      results.push(eq);
    }
    saveState(state);
    return results;
  }

  // -------------------------------------------------------------
  // 10-2. 装備分解 → 還元星リソース化（SS-6 v3.3.0）
  //   - rarity 1 (N)  → +1 星
  //   - rarity 2 (R)  → +2 星
  //   - rarity 3 (SR) → +10 星（固定）
  //   - rarity 4 (SSR)→ +20 星（固定）
  //   - rarity 5 (UR) → +50 星
  //   - equipped 装備は分解不可（誤操作ガード）
  //   - 戻り値：{ ok:true, stars, rarity, removedItemId } or { ok:false, reason }
  // -------------------------------------------------------------
  var DISASSEMBLE_STAR_TABLE = { 1: 1, 2: 2, 3: 10, 4: 20, 5: 50 };
  function disassembleEquipment(itemId) {
    var state = loadState();
    var target = (state.equipment || []).find(function (e) { return e.id === itemId; });
    if (!target) return { ok: false, reason: 'not-found' };
    if (target.equipped) return { ok: false, reason: 'equipped' };
    var stars = DISASSEMBLE_STAR_TABLE[target.rarity] || 1;
    state.equipment = state.equipment.filter(function (e) { return e.id !== itemId; });
    state.stars = (state.stars || 0) + stars;
    saveState(state);
    return { ok: true, stars: stars, rarity: target.rarity, removedItemId: itemId };
  }

  // -------------------------------------------------------------
  // 11. 装備合成（同 rarity 2 個 → 上位 rarity 1 個）
  // -------------------------------------------------------------
  function mergeEquipment(idA, idB) {
    var state = loadState();
    var a = (state.equipment || []).find(function (e) { return e.id === idA; });
    var b = (state.equipment || []).find(function (e) { return e.id === idB; });
    if (!a || !b) return { ok: false, reason: 'not-found' };
    if (a.id === b.id) return { ok: false, reason: 'same-id' };
    if (a.rarity !== b.rarity) return { ok: false, reason: 'rarity-mismatch' };
    if (a.rarity >= 5) return { ok: false, reason: 'max-rarity' };
    // remove
    state.equipment = state.equipment.filter(function (e) { return e.id !== idA && e.id !== idB; });
    var newRarity = a.rarity + 1;
    var newSlot = a.slot;
    var fused = makeEquipment(newSlot, newRarity);
    state.equipment.push(fused);
    saveState(state);
    return { ok: true, fused: fused };
  }

  // -------------------------------------------------------------
  // 12. 装備 equip / unequip（slot 排他）
  // -------------------------------------------------------------
  function equipItem(itemId) {
    var state = loadState();
    var target = (state.equipment || []).find(function (e) { return e.id === itemId; });
    if (!target) return false;
    // SS-4 旧 'acc' を 'acc1' に正規化（migration 漏れ保険）
    if (target.slot === 'acc') target.slot = 'acc1';
    // SS-4 未解禁スロットへの装備はブロック
    var requiredLv = SLOT_UNLOCK_LV[target.slot] || 1;
    if ((state.level || 1) < requiredLv) return false;
    state.equipment.forEach(function (e) { if (e.slot === target.slot) e.equipped = false; });
    target.equipped = true;
    saveState(state);
    return true;
  }
  function unequipItem(itemId) {
    var state = loadState();
    var t = (state.equipment || []).find(function (e) { return e.id === itemId; });
    if (!t) return false;
    t.equipped = false;
    saveState(state);
    return true;
  }

  // -------------------------------------------------------------
  // 13. 称号解禁チェック（state 変更後にコール）
  // -------------------------------------------------------------
  function unlockTitles(state) {
    var unlocked = [];
    var have = {};
    (state.titles || []).forEach(function (t) { have[t.id] = true; });
    TITLES.forEach(function (def) {
      if (have[def.id]) return;
      try {
        if (def.check(state)) {
          state.titles.push({ id: def.id, name: def.name, unlockedAt: Date.now() });
          unlocked.push(def);
        }
      } catch (_) {}
    });
    return unlocked;
  }

  // -------------------------------------------------------------
  // 14. プレステージ（Lv 上限 50 到達でリセット・永続 +15% 補正）
  //   SS-5（v3.3.0）：プレステ N 回ごとに敵 HP / ATK が ×(1 + N×0.2) スケール
  //   - 自分側補正 +15%/回 は computePlayerStats() で既存維持
  //   - 敵側補正 +20%/回 は instantiateEnemy() で戦闘開始時に動的適用
  //   - ENEMIES 配列は不変（参照表）／state.prestige カウンタ増分のみで自動反映
  // -------------------------------------------------------------
  var PRESTIGE_LV_THRESHOLD = 50;
  var PRESTIGE_ENEMY_SCALE_PER_LEVEL = 0.2; // SS-5：敵強化倍率（×0.2/回）
  function prestige() {
    var state = loadState();
    if ((state.level || 1) < PRESTIGE_LV_THRESHOLD) return { ok: false, reason: 'level-too-low' };
    state.prestige = (state.prestige || 0) + 1;
    state.xp = 0;
    state.level = 1;
    // 装備・コイン・称号は維持
    saveState(state);
    var enemyMul = 1 + state.prestige * PRESTIGE_ENEMY_SCALE_PER_LEVEL;
    return {
      ok: true,
      prestige: state.prestige,
      // SS-5：UI/HUD 表示用メッセージ（敵が強化されたことを通知）
      message: 'プレステージ ★' + state.prestige + ' 達成！自分 +' + Math.round(state.prestige * 15) + '% / 敵強化 ×' + enemyMul.toFixed(1) + '（HP・ATK）',
      enemyScale: enemyMul
    };
  }

  // -------------------------------------------------------------
  // 14.1. instantiateEnemy（SS-5：戦闘開始時に敵 instance を生成）
  //   - state.prestige × 0.2 倍で hp / atk をスケール
  //   - 全 phase に同倍率適用（多段階 HP ボスの中ボス・大ボス対応）
  //   - 元の enemyDef は不変（ENEMIES 配列を書き換えない）
  //   - 報酬（reward.xp / coin / dropChance）は据え置き（SS-5 スコープ外）
  // -------------------------------------------------------------
  function instantiateEnemy(enemyDef, state) {
    if (!enemyDef || !enemyDef.phases) return enemyDef;
    var prestigeLv = (state && state.prestige) || 0;
    var mult = 1 + prestigeLv * PRESTIGE_ENEMY_SCALE_PER_LEVEL;
    if (mult === 1) return enemyDef; // state.prestige=0 は変化なしで早期 return
    var phases = enemyDef.phases.map(function (p) {
      var scaledHp = Math.round((p.hp || 0) * mult);
      var scaledAtk = Math.round((p.atk || 0) * mult);
      // Object.assign で元 phase を非破壊コピー（color/cry 等を保持）
      return Object.assign({}, p, {
        hp: scaledHp,
        atk: scaledAtk,
        maxHp: scaledHp // 表示用（HP バー max 値）
      });
    });
    return Object.assign({}, enemyDef, { phases: phases, _scaled: mult });
  }

  // -------------------------------------------------------------
  // 14.5. 週替り挑戦システム（SS-3 / v3.3.0 phase 0）
  //   - 毎週月曜 0:00（JST）に挑戦妖怪が更新（pool[weekIndex % 12]）
  //   - 通常体撃破 × 3 倍（XP / coin / 装備ドロップ率）
  //   - 1 週 1 体・週内に撃破不問・再戦可能・倍率維持
  //   - 12 体プール（年内ローテ）：日本 6 + 海外 6 の中ボス〜大ボス級
  //     ※ 既存 8 体（haku_gami / thunder_drum / rhythm_miko / eight_drum /
  //        wind_shaker / tsukuyomi_click / kusanagi_snare / amatsu_drummer）
  //        は除外＝既存ローテ枠／隠し妖怪も除外＝出現条件複雑
  // -------------------------------------------------------------
  var WEEKLY_CHALLENGE_POOL = [
    // ---- 日本神話 6 体（中ボス〜大ボス級）----
    'susanoo',         // 嵐神（unlockLv 18・中ボス・2 段階）
    'izanagi',         // 創造神（unlockLv 22・中ボス・2 段階）
    'izanami',         // 黄泉神（unlockLv 25・大ボス・3 段階）
    'takemikazuchi',   // 雷剣スネア神（中ボス）
    'shutendoji',      // 鬼神大ボス
    'omononushi',      // 蛇神ポリリズム（大ボス）
    // ---- 海外神話 6 体（中ボス〜大ボス級）----
    'thor',            // 北欧雷神
    'dionysos',        // 狂乱拍ボス
    'quetzalcoatl',    // メソアメリカ羽蛇王
    'tlaloc',          // アステカ雷神
    'tezcatlipoca',    // 煙鏡夜の神
    'pele'             // ハワイ火山拍
  ];

  var WEEKLY_CHALLENGE_MULTIPLIER = 3;     // 報酬・ドロップ率倍率
  var WEEKLY_EPOCH_MS = Date.UTC(2026, 0, 5) - 9 * 60 * 60 * 1000;
  // 起算月曜：2026-01-05 00:00 JST = 2026-01-04 15:00 UTC
  // （JST 月曜 0:00 を基準に 7 日刻みで weekIndex を計算）

  /**
   * getWeekIndex(date)
   *   - JST 月曜 0:00 起算で何週目か（0 始まり）を返す
   *   - 引数省略時は現在時刻
   *   - 月曜以外 / 同月曜内のどの時刻でも、その週の index を返す
   */
  function getWeekIndex(date) {
    var t = (date instanceof Date ? date.getTime() : (typeof date === 'number' ? date : Date.now()));
    var diff = t - WEEKLY_EPOCH_MS;
    if (diff < 0) return 0;
    return Math.floor(diff / (7 * 24 * 60 * 60 * 1000));
  }

  /**
   * getCurrentWeeklyChallenge()
   *   - 今週の挑戦妖怪オブジェクト（ENEMIES から検索）を返す
   *   - 該当なし時は null（pool 未定義 / id 不一致）
   */
  function getCurrentWeeklyChallenge(date) {
    if (!Array.isArray(WEEKLY_CHALLENGE_POOL) || WEEKLY_CHALLENGE_POOL.length === 0) return null;
    var idx = getWeekIndex(date) % WEEKLY_CHALLENGE_POOL.length;
    var id = WEEKLY_CHALLENGE_POOL[idx];
    var enemy = ENEMIES.filter(function (e) { return e.id === id; })[0];
    return enemy || null;
  }

  /**
   * getWeeklyChallengeContext(state)
   *   - 今週情報パッケージ（UI / 戦闘両用）
   *   - { weekIndex, enemyId, enemy, multiplier, weekStartMs, weekEndMs, defeatedThisWeek }
   */
  function getWeeklyChallengeContext(state, date) {
    var idx = getWeekIndex(date);
    var enemy = getCurrentWeeklyChallenge(date);
    var weekStart = WEEKLY_EPOCH_MS + idx * 7 * 24 * 60 * 60 * 1000;
    var weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;
    // 今週の撃破回数（state.weeklyHistory から集計）
    var defeatedThisWeek = 0;
    if (state && Array.isArray(state.weeklyHistory)) {
      for (var i = 0; i < state.weeklyHistory.length; i++) {
        var h = state.weeklyHistory[i];
        if (!h) continue;
        if (h.weekIndex === idx && enemy && h.enemyId === enemy.id && h.defeated) defeatedThisWeek++;
      }
    }
    return {
      weekIndex: idx,
      enemyId: enemy ? enemy.id : null,
      enemy: enemy,
      multiplier: WEEKLY_CHALLENGE_MULTIPLIER,
      weekStartMs: weekStart,
      weekEndMs: weekEnd,
      defeatedThisWeek: defeatedThisWeek
    };
  }

  /**
   * recordWeeklyHistory(state, enemyId, defeated)
   *   - 戦闘終了時に呼ぶ。今週の挑戦妖怪と一致した場合のみ記録
   *   - state.weeklyHistory: array of { weekIndex, enemyId, defeated, defeatedAt }
   */
  function recordWeeklyHistory(state, enemyId, defeated) {
    if (!state) return state;
    if (!Array.isArray(state.weeklyHistory)) state.weeklyHistory = [];
    var idx = getWeekIndex();
    var current = getCurrentWeeklyChallenge();
    if (!current || current.id !== enemyId) return state;
    state.weeklyHistory.push({
      weekIndex: idx,
      enemyId: enemyId,
      defeated: !!defeated,
      defeatedAt: defeated ? Date.now() : null
    });
    // 履歴は直近 52 週分まで保持（年単位）
    if (state.weeklyHistory.length > 200) {
      state.weeklyHistory = state.weeklyHistory.slice(-200);
    }
    return state;
  }

  /**
   * isWeeklyChallengeTarget(enemyId)
   *   - 与えた敵 id が今週の挑戦対象なら true
   */
  function isWeeklyChallengeTarget(enemyId) {
    var c = getCurrentWeeklyChallenge();
    return !!(c && c.id === enemyId);
  }

  // -------------------------------------------------------------
  // 15. 敵候補 pickEnemy（Lv／隠し条件で絞る）
  // -------------------------------------------------------------
  function pickEnemy(state) {
    var available = ENEMIES.filter(function (e) {
      if (e.isHidden) {
        if (e.hiddenCondition === 'midnight_practice') {
          // SteadyUseLog の sessions から 22:00〜04:00 の起動を検出
          try {
            var st = global.SteadyUseLog && global.SteadyUseLog.getState && global.SteadyUseLog.getState();
            if (st && Array.isArray(st.sessions)) {
              for (var i = 0; i < st.sessions.length; i++) {
                var s = st.sessions[i];
                if (!s || !s.startedAt) continue;
                var h = new Date(s.startedAt).getHours();
                if (h >= 22 || h < 4) return true;
              }
            }
          } catch (_) {}
          return false;
        }
        if (e.hiddenCondition === 'streak_14') {
          try {
            var d = global.SteadyUseLog && global.SteadyUseLog.getStreakDays && global.SteadyUseLog.getStreakDays();
            return (d || 0) >= 14;
          } catch (_) { return false; }
        }
        // SS-1.5 新規隠し 4 条件
        if (e.hiddenCondition === 'losses_3_streak') {
          // 鵺：直近 3 連敗で出現
          return (state.loseStreak || 0) >= 3;
        }
        if (e.hiddenCondition === 'defeated_15_uniques') {
          // ぬらりひょん：ユニーク撃破 15 体以上
          try {
            var defeatedMap = state.defeated || {};
            var uniqueCount = 0;
            var keys = Object.keys(defeatedMap);
            for (var j = 0; j < keys.length; j++) {
              var rec = defeatedMap[keys[j]];
              if (rec && (rec.count || 0) >= 1) uniqueCount++;
            }
            return uniqueCount >= 15;
          } catch (_) { return false; }
        }
        if (e.hiddenCondition === 'late_night_50') {
          // Anubis：深夜（0-4時）累計撃破 50 体
          return (state.lateNightDefeats || 0) >= 50;
        }
        if (e.hiddenCondition === 'streak_30') {
          // Kupala：連続練習 30 日（SteadyUseLog 経由・streak_14 と同じソース）
          try {
            var d30 = global.SteadyUseLog && global.SteadyUseLog.getStreakDays && global.SteadyUseLog.getStreakDays();
            return (d30 || 0) >= 30;
          } catch (_) { return false; }
        }
        return false;
      }
      return (state.level || 1) >= e.unlockLevel;
    });
    if (available.length === 0) return ENEMIES[0]; // 拍神 fallback
    return available[Math.floor(Math.random() * available.length)];
  }

  // -------------------------------------------------------------
  // 16. AutoBattle（観戦型・rAF ベース）
  // -------------------------------------------------------------
  function AutoBattle(opts) {
    this.opts = opts || {};
    this.onUpdate = opts.onUpdate || function () {};
    this.onLog = opts.onLog || function () {};
    this.onEnd = opts.onEnd || function () {};
    this.state = loadState();
    // SS-5：プレステ敵強化スケール（state.prestige × 0.2）を戦闘開始時に動的適用
    //   - ENEMIES 配列は書き換えない（参照表として保持）
    //   - 全 phase に同倍率（多段階 HP ボス対応）
    //   - state.prestige=0 なら instantiateEnemy() は素通し（no-op）
    var rawEnemy = opts.enemy || pickEnemy(this.state);
    this.enemy = instantiateEnemy(rawEnemy, this.state);
    this.player = computePlayerStats(this.state);
    this.playerHp = this.player.hp;
    this.playerHpMax = this.player.hp;
    // 形態作成
    this.phaseIdx = 0;
    var ph = this.enemy.phases[0];
    this.enemyHp = ph.hp;
    this.enemyHpMax = ph.hp;
    this.tStart = performance.now();
    this.lastTick = this.tStart;
    this.lastAtk = this.tStart;
    this.totalDmgToEnemy = 0;
    this.endedAt = null;
    this.result = null; // 'win' | 'lose'
    this.timeline = [];
    this.running = false;
    this.rafId = 0;
  }
  AutoBattle.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.onLog({ kind: 'intro', text: this.enemy.lines.intro });
    this._loop();
  };
  AutoBattle.prototype._loop = function () {
    if (!this.running) return;
    var now = performance.now();
    var dt = now - this.lastTick;
    this.lastTick = now;
    // 攻撃間隔（プレイヤー：500-700ms / 敵：800-1100ms）
    var pAtkInterval = 600 + Math.random() * 200;
    var eAtkInterval = 900 + Math.random() * 200;
    if (now - this.lastAtk >= pAtkInterval) {
      this.lastAtk = now;
      this._playerAttack();
      // 敵反撃
      setTimeout(this._enemyAttack.bind(this), Math.min(eAtkInterval, 600));
    }
    this.onUpdate({
      playerHp: this.playerHp, playerHpMax: this.playerHpMax,
      enemyHp: this.enemyHp, enemyHpMax: this.enemyHpMax,
      enemy: this.enemy,
      phaseIdx: this.phaseIdx,
      elapsed: now - this.tStart,
      result: this.result
    });
    if (this.result) return this._end();
    var elapsed = now - this.tStart;
    if (elapsed > 90000) {
      // タイムアウト：HP 比較で判定（保険）
      this.result = (this.enemyHp <= this.playerHp) ? 'win' : 'lose';
      return this._end();
    }
    this.rafId = requestAnimationFrame(this._loop.bind(this));
  };
  AutoBattle.prototype._playerAttack = function () {
    var hit = (Math.random() * 100) < this.player.acc;
    var dmg = hit ? Math.max(1, Math.round(this.player.atk + (Math.random() * 6 - 2))) : 0;
    var crit = hit && Math.random() < 0.12;
    if (crit) dmg = Math.round(dmg * 1.7);
    this.enemyHp -= dmg;
    this.totalDmgToEnemy += dmg;
    this.onLog({ kind: 'p-atk', text: hit ? ('▶ ' + dmg + ' ダメージ' + (crit ? '（会心）' : '')) : '▶ Miss' });
    if (this.enemyHp <= 0) {
      // 形態移行 or 撃破
      if (this.phaseIdx < this.enemy.phases.length - 1) {
        this.phaseIdx++;
        var nph = this.enemy.phases[this.phaseIdx];
        this.enemyHp = nph.hp;
        this.enemyHpMax = nph.hp;
        this.onLog({ kind: 'rage', text: nph.cry });
      } else {
        this.result = 'win';
      }
    }
  };
  AutoBattle.prototype._enemyAttack = function () {
    if (this.result) return;
    var ph = this.enemy.phases[this.phaseIdx];
    var dmg = Math.max(1, Math.round(ph.atk + (Math.random() * 4 - 1)));
    // miss 10%
    if (Math.random() < 0.1) {
      this.onLog({ kind: 'e-miss', text: '◀ ' + this.enemy.name + ' の攻撃は空振り' });
      return;
    }
    this.playerHp -= dmg;
    this.onLog({ kind: 'e-atk', text: '◀ ' + dmg + ' ダメージ' });
    if (this.playerHp <= 0) {
      this.playerHp = 0;
      this.result = 'lose';
    }
  };
  AutoBattle.prototype._end = function () {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    var state = loadState();
    var elapsed = performance.now() - this.tStart;
    state.battlesPlayed = (state.battlesPlayed || 0) + 1;
    var earned = { xp: 0, coins: 0, equipment: null, weeklyBonus: false };
    // SS-3 週替り挑戦：今週の挑戦妖怪なら ×3 倍適用（XP / coin / dropChance）
    var isWeekly = isWeeklyChallengeTarget(this.enemy.id);
    var weeklyMul = isWeekly ? WEEKLY_CHALLENGE_MULTIPLIER : 1;
    if (this.result === 'win') {
      var rew = this.enemy.reward;
      earned.xp = (rew.xp + Math.round(this.state.level * 1.5)) * weeklyMul;
      earned.coins = rew.coin * weeklyMul;
      earned.weeklyBonus = isWeekly;
      gainXP(state, earned.xp);
      gainCoins(state, earned.coins);
      // ドロップ：週替り対象なら dropChance × 3（上限 1.0）で一時上書き
      var dropTarget = this.enemy;
      if (isWeekly) {
        var origReward = this.enemy.reward || {};
        var boostedChance = Math.min(1, (origReward.dropChance || 0.5) * WEEKLY_CHALLENGE_MULTIPLIER);
        dropTarget = {
          isBoss: this.enemy.isBoss,
          reward: {
            xp: origReward.xp,
            coin: origReward.coin,
            dropChance: boostedChance
          }
        };
      }
      var dropped = dropEquipment(state, dropTarget);
      if (dropped) earned.equipment = dropped;
      // defeated
      state.defeated = state.defeated || {};
      var rec = state.defeated[this.enemy.id] || { count: 0, firstAt: Date.now(), bestTimeMs: null, bestDmg: 0 };
      rec.count++;
      if (!rec.bestTimeMs || elapsed < rec.bestTimeMs) rec.bestTimeMs = Math.round(elapsed);
      if (this.totalDmgToEnemy > rec.bestDmg) rec.bestDmg = this.totalDmgToEnemy;
      state.defeated[this.enemy.id] = rec;
      // records
      state.wins = (state.wins || 0) + 1;
      state.records.currentStreak = (state.records.currentStreak || 0) + 1;
      if (state.records.currentStreak > (state.records.longestStreak || 0)) {
        state.records.longestStreak = state.records.currentStreak;
      }
      if (this.totalDmgToEnemy > (state.records.bestDamage || 0)) state.records.bestDamage = this.totalDmgToEnemy;
      if (!state.records.fastestWinMs || elapsed < state.records.fastestWinMs) state.records.fastestWinMs = Math.round(elapsed);
      // SS-1.5 隠し 4 体トラッキング：win 時 loseStreak リセット／深夜（0-4時）撃破カウント
      state.loseStreak = 0;
      var winHour = new Date().getHours();
      if (winHour >= 0 && winHour < 4) {
        state.lateNightDefeats = (state.lateNightDefeats || 0) + 1;
      }
      // SS-3 週替り挑戦：今週の挑戦妖怪を倒したら history に記録
      recordWeeklyHistory(state, this.enemy.id, true);
      var winMsg = this.enemy.lines.win + ' / +' + earned.xp + 'XP +' + earned.coins + 'C';
      if (earned.weeklyBonus) winMsg += '（今週の挑戦 ×' + WEEKLY_CHALLENGE_MULTIPLIER + ' 倍）';
      this.onLog({ kind: 'win', text: winMsg });
    } else {
      state.losses = (state.losses || 0) + 1;
      state.records.currentStreak = 0;
      // SS-1.5 隠し 4 体トラッキング：lose 時 loseStreak インクリメント
      state.loseStreak = (state.loseStreak || 0) + 1;
      // SS-3 週替り挑戦：敗北も記録（撃破不問の挑戦履歴トラッキング）
      recordWeeklyHistory(state, this.enemy.id, false);
      this.onLog({ kind: 'lose', text: this.enemy.lines.lose });
    }
    var newTitles = unlockTitles(state);
    saveState(state);
    this.onEnd({
      result: this.result, elapsed: elapsed, earned: earned,
      enemy: this.enemy, newTitles: newTitles
    });
  };
  AutoBattle.prototype.abort = function () {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  };

  // wrapper function 形式（grep 検証 #1 用に明示）
  function autoBattle(opts) {
    var ab = new AutoBattle(opts || {});
    ab.start();
    return ab;
  }

  // -------------------------------------------------------------
  // 17. UI レイヤ（GAME タブのオートバトル / ガチャ / 装備 / やりこみ）
  // -------------------------------------------------------------
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // SS-3 週替り挑戦 UI セクション renderer
  function renderWeeklyChallenge() {
    var box = document.getElementById('weeklyChallengePanel');
    if (!box) return;
    var state = loadState();
    var ctx = getWeeklyChallengeContext(state);
    if (!ctx.enemy) {
      box.innerHTML = '<div class="muted-text small">今週の挑戦は準備中です（プールが空）。</div>';
      return;
    }
    var e = ctx.enemy;
    var rec = (state.defeated || {})[e.id];
    var defeatedAll = rec ? rec.count : 0;
    var thisWeekClears = ctx.defeatedThisWeek;
    var hpTotal = (e.phases || []).reduce(function (a, p) { return a + (p.hp || 0); }, 0);
    // 残り時間（週末まで）
    var msLeft = ctx.weekEndMs - Date.now();
    var dLeft = Math.max(0, Math.floor(msLeft / (24 * 60 * 60 * 1000)));
    var hLeft = Math.max(0, Math.floor((msLeft % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000)));
    var phaseCount = (e.phases || []).length;
    var primaryColor = (e.phases && e.phases[0] && e.phases[0].color) || '#7c6af7';

    box.innerHTML =
      '<div class="weekly-head">' +
        '<span class="weekly-label">今週の挑戦</span>' +
        '<span class="weekly-multi-badge" aria-label="報酬 3 倍">×' + WEEKLY_CHALLENGE_MULTIPLIER + ' 倍報酬</span>' +
      '</div>' +
      '<div class="weekly-body" style="--weekly-color:' + primaryColor + '">' +
        '<div class="weekly-glyph" aria-hidden="true">⚔️</div>' +
        '<div class="weekly-meta">' +
          '<div class="weekly-name">' + escapeHtml(e.name) +
            (phaseCount > 1 ? '<span class="weekly-phase-tag">' + phaseCount + ' 段階</span>' : '') +
          '</div>' +
          '<div class="weekly-title muted-text small">' + escapeHtml(e.title) + ' / ' + escapeHtml(e.motif) + '</div>' +
          '<div class="weekly-stats">' +
            '<span>総 HP <b>' + hpTotal + '</b></span>' +
            '<span>今週撃破 <b>' + thisWeekClears + '</b></span>' +
            '<span>累計 <b>' + defeatedAll + '</b></span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="weekly-foot">' +
        '<span class="weekly-countdown">残り ' + dLeft + ' 日 ' + hLeft + ' 時間</span>' +
        '<button class="btn-primary weekly-cta" id="weeklyChallengeBtn" type="button">今週の挑戦に挑む</button>' +
      '</div>' +
      '<div class="muted-text small weekly-note">' +
        '毎週月曜 0:00（JST）に挑戦相手が更新。撃破不問で今週中は何度でも ×' + WEEKLY_CHALLENGE_MULTIPLIER + ' 倍報酬。' +
      '</div>';

    var btn = document.getElementById('weeklyChallengeBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        var c = getCurrentWeeklyChallenge();
        if (!c) return;
        openBattleUI({ enemy: c });
      });
    }
  }

  function renderHud(state) {
    var hud = document.getElementById('gameHud');
    if (!hud) return;
    var stats = computePlayerStats(state);
    var nextXp = xpToNextLevel(state);
    // SS-5：プレステ敵強化倍率の HUD 表示（state.prestige > 0 のみ）
    var enemyScaleLabel = '';
    if (state.prestige) {
      var enemyMul = 1 + state.prestige * PRESTIGE_ENEMY_SCALE_PER_LEVEL;
      enemyScaleLabel = ' <small title="プレステ敵強化倍率（HP/ATK）">敵×' + enemyMul.toFixed(1) + '</small>';
    }
    hud.innerHTML =
      '<div class="hud-row">' +
        '<div class="hud-cell"><span class="hud-label">Lv</span><span class="hud-val">' + state.level + (state.prestige ? ' <small>★' + state.prestige + '</small>' : '') + enemyScaleLabel + '</span></div>' +
        '<div class="hud-cell"><span class="hud-label">XP</span><span class="hud-val">' + state.xp + ' <small>(次まで ' + nextXp + ')</small></span></div>' +
        '<div class="hud-cell"><span class="hud-label">🪙</span><span class="hud-val">' + state.coins + '</span></div>' +
        // SS-6 還元星リソース表示
        '<div class="hud-cell hud-cell-stars" title="装備分解で得られる還元星（ガチャ通貨に使用可）"><span class="hud-label">🌟</span><span class="hud-val">' + (state.stars || 0) + '</span></div>' +
      '</div>' +
      '<div class="hud-row">' +
        '<div class="hud-cell"><span class="hud-label">HP</span><span class="hud-val">' + stats.hp + '</span></div>' +
        '<div class="hud-cell"><span class="hud-label">ATK</span><span class="hud-val">' + stats.atk + '</span></div>' +
        '<div class="hud-cell"><span class="hud-label">命中</span><span class="hud-val">' + stats.acc + '%</span></div>' +
      '</div>' +
      '<div class="hud-row hud-records">' +
        '<span>戦績 ' + (state.wins || 0) + '勝 ' + (state.losses || 0) + '敗</span>' +
        '<span>連勝 ' + (state.records.currentStreak || 0) + '（最長 ' + (state.records.longestStreak || 0) + '）</span>' +
        '<span>最大ダメ ' + (state.records.bestDamage || 0) + '</span>' +
      '</div>';
  }

  function openBattleUI(opts) {
    var modal = document.getElementById('battleModal');
    if (!modal) return;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    var ab = autoBattle({
      enemy: opts && opts.enemy,
      onUpdate: function (st) {
        var phn = (st.phaseIdx + 1) + '/' + st.enemy.phases.length;
        var ph = st.enemy.phases[st.phaseIdx];
        var tile = document.getElementById('battleEnemyTile');
        if (tile) tile.style.setProperty('--enemy-color', ph.color);
        document.getElementById('battleEnemyName').textContent = st.enemy.name + (st.enemy.phases.length > 1 ? '（' + phn + '）' : '');
        document.getElementById('battleEnemyTitle').textContent = st.enemy.title + ' / ' + st.enemy.motif;
        var ehBar = document.getElementById('battleEnemyHpBar');
        var phBar = document.getElementById('battlePlayerHpBar');
        if (ehBar) ehBar.style.width = Math.max(0, (st.enemyHp / st.enemyHpMax * 100)) + '%';
        if (phBar) phBar.style.width = Math.max(0, (st.playerHp / st.playerHpMax * 100)) + '%';
        document.getElementById('battleEnemyHpTxt').textContent = Math.max(0, st.enemyHp) + ' / ' + st.enemyHpMax;
        document.getElementById('battlePlayerHpTxt').textContent = Math.max(0, st.playerHp) + ' / ' + st.playerHpMax;
      },
      onLog: function (entry) {
        var log = document.getElementById('battleLog');
        if (!log) return;
        var div = document.createElement('div');
        div.className = 'battle-log-line battle-log-' + entry.kind;
        div.textContent = entry.text;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
        // 古い行を間引き（200 行超）
        while (log.children.length > 200) log.removeChild(log.firstChild);
      },
      onEnd: function (res) {
        var foot = document.getElementById('battleFoot');
        if (foot) {
          var msg = '';
          if (res.result === 'win') {
            msg = '🎉 勝利！ +' + res.earned.xp + ' XP / +' + res.earned.coins + ' 🪙';
            if (res.earned.equipment) {
              var rar = RARITY_LABEL[res.earned.equipment.rarity];
              msg += ' / 装備ドロップ：[' + rar + '] ' + res.earned.equipment.name;
            }
            if (res.newTitles && res.newTitles.length) {
              msg += ' / 称号解禁：' + res.newTitles.map(function (t) { return t.name; }).join('・');
            }
          } else {
            msg = '💀 敗北… 充電してから再挑戦しよう';
          }
          foot.innerHTML = '<div class="battle-result ' + res.result + '">' + escapeHtml(msg) + '</div>' +
            '<div class="row" style="margin-top:8px;">' +
              '<button class="btn-primary" id="battleAgainBtn" type="button">もう一度</button>' +
              '<button class="btn-secondary" id="battleCloseBtn" type="button">閉じる</button>' +
            '</div>';
          document.getElementById('battleAgainBtn').addEventListener('click', function () {
            closeBattleUI();
            setTimeout(function () { openBattleUI({}); }, 100);
          });
          document.getElementById('battleCloseBtn').addEventListener('click', function () {
            closeBattleUI();
            renderAll();
          });
        }
        renderHud(loadState());
      }
    });
    modal._ab = ab;
    // 充電済 HP / 表示 init
    document.getElementById('battleLog').innerHTML = '';
    document.getElementById('battleFoot').innerHTML = '<div class="muted-text small">戦闘中…観戦モード（自動進行）</div>';
  }

  function closeBattleUI() {
    var modal = document.getElementById('battleModal');
    if (!modal) return;
    if (modal._ab) modal._ab.abort();
    modal.classList.remove('open');
    document.body.style.overflow = '';
  }

  // SS-4 装備スロット解禁状況パネル（装備一覧上部に挿入）
  function renderSlotUnlockPanel(state) {
    var lv = state.level || 1;
    var unlocked = unlockedSlots(lv);
    var unlockedSet = {};
    unlocked.forEach(function (s) { unlockedSet[s] = true; });
    var equippedBySlot = {};
    (state.equipment || []).forEach(function (e) {
      if (e && e.equipped) equippedBySlot[e.slot] = e;
    });
    var cells = SLOTS.map(function (slot) {
      var open = !!unlockedSet[slot];
      var label = SLOT_LABEL[slot] || slot;
      var requiredLv = SLOT_UNLOCK_LV[slot] || 1;
      var eq = equippedBySlot[slot];
      var inner;
      if (!open) {
        inner =
          '<span class="slot-cell-icon" aria-hidden="true">🔒</span>' +
          '<span class="slot-cell-label">' + label + '</span>' +
          '<span class="slot-cell-hint">Lv ' + requiredLv + ' で解禁</span>';
      } else if (eq) {
        var col = RARITY_COLOR[eq.rarity] || 'var(--accent-primary)';
        inner =
          '<span class="slot-cell-icon" aria-hidden="true">⚔️</span>' +
          '<span class="slot-cell-label">' + label + '</span>' +
          '<span class="slot-cell-eq" style="color:' + col + '">[' + RARITY_LABEL[eq.rarity] + '] ' + escapeHtml(eq.name) + '</span>';
      } else {
        inner =
          '<span class="slot-cell-icon" aria-hidden="true">▫️</span>' +
          '<span class="slot-cell-label">' + label + '</span>' +
          '<span class="slot-cell-hint">未装備</span>';
      }
      return '<div class="slot-cell ' + (open ? 'is-open' : 'is-locked') + '" data-slot="' + slot + '">' + inner + '</div>';
    }).join('');
    return '<div class="slot-unlock-panel" aria-label="装備スロット解禁状況">' + cells + '</div>';
  }

  function renderEquipmentList() {
    var box = document.getElementById('equipList');
    if (!box) return;
    var state = loadState();
    var panelHtml = renderSlotUnlockPanel(state);
    var items = (state.equipment || []).slice().sort(function (a, b) {
      return (b.rarity - a.rarity) || (b.dropAt - a.dropAt);
    });
    if (items.length === 0) {
      box.innerHTML = panelHtml + '<div class="muted-text small">装備なし。オートバトルで勝利するかガチャを引こう。</div>';
      return;
    }
    var equippedBySlot = {};
    items.forEach(function (e) { if (e.equipped) equippedBySlot[e.slot] = e.id; });
    box.innerHTML = panelHtml + items.map(function (e) {
      var rar = RARITY_LABEL[e.rarity];
      var col = RARITY_COLOR[e.rarity];
      var equipped = e.equipped ? '<span class="equip-tag">装備中</span>' : '';
      var slotJp = SLOT_LABEL[e.slot] || e.slot;
      // SS-4 未解禁スロットの装備はロック表示
      var requiredLv = SLOT_UNLOCK_LV[e.slot] || 1;
      var lockedByLv = (state.level || 1) < requiredLv;
      if (lockedByLv) {
        slotJp += ' 🔒Lv' + requiredLv;
      }
      // SS-6 分解で得られる還元星数（プレビュー）
      var disStars = DISASSEMBLE_STAR_TABLE[e.rarity] || 1;
      return '<div class="equip-item" data-id="' + e.id + '" style="border-color:' + col + '">' +
        '<div class="equip-head">' +
          '<span class="equip-rar" style="background:' + col + '">★' + rar + '</span>' +
          '<span class="equip-name">' + escapeHtml(e.name) + '</span>' +
          equipped +
        '</div>' +
        '<div class="equip-body">' +
          '<span class="equip-slot">' + slotJp + '</span>' +
          (e.atk ? '<span class="equip-stat">ATK +' + e.atk + '</span>' : '') +
          (e.hp ? '<span class="equip-stat">HP +' + e.hp + '</span>' : '') +
          (e.acc ? '<span class="equip-stat">命中 +' + e.acc + '</span>' : '') +
        '</div>' +
        '<div class="equip-actions">' +
          (e.equipped
            ? '<button class="btn-secondary" data-act="unequip" type="button">外す</button>'
            : '<button class="btn-primary" data-act="equip" type="button"' +
              (lockedByLv ? ' disabled title="Lv ' + requiredLv + ' で解禁"' : '') +
              '>装備</button>') +
          '<button class="btn-secondary" data-act="merge-pick" type="button">合成候補</button>' +
          // SS-6 分解ボタン（equipped 中は disabled）
          '<button class="btn-danger btn-disassemble" data-act="disassemble" type="button"' +
            (e.equipped ? ' disabled title="装備中は分解できません（先に外してください）"' : ' title="分解して 🌟' + disStars + ' を獲得"') +
            '>分解 🌟' + disStars + '</button>' +
        '</div>' +
      '</div>';
    }).join('');
    // 装備ボタン
    box.querySelectorAll('[data-act="equip"]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.closest('.equip-item').dataset.id;
        equipItem(id);
        renderAll();
      });
    });
    box.querySelectorAll('[data-act="unequip"]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.closest('.equip-item').dataset.id;
        unequipItem(id);
        renderAll();
      });
    });
    box.querySelectorAll('[data-act="merge-pick"]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.closest('.equip-item').dataset.id;
        handleMergePick(id);
      });
    });
    // SS-6 分解ボタン（equipped 中は disabled・confirm ダイアログでミス防止）
    box.querySelectorAll('[data-act="disassemble"]').forEach(function (b) {
      b.addEventListener('click', function () {
        var item = b.closest('.equip-item');
        if (!item) return;
        var id = item.dataset.id;
        var nameEl = item.querySelector('.equip-name');
        var nameText = nameEl ? nameEl.textContent : '装備';
        if (!global.confirm || !global.confirm('「' + nameText + '」を分解しますか？（還元星に変換／取り消し不可）')) return;
        var res = disassembleEquipment(id);
        if (res.ok) {
          announce('🔨 分解：[' + (RARITY_LABEL[res.rarity] || '?') + '] → 🌟 +' + res.stars + '（合計 ' + (loadState().stars || 0) + '）');
        } else {
          announce('分解失敗：' + res.reason);
        }
        renderAll();
      });
    });
  }

  var _mergePick = null;
  function handleMergePick(id) {
    var state = loadState();
    var picked = state.equipment.find(function (e) { return e.id === id; });
    if (!picked) return;
    if (!_mergePick) {
      _mergePick = id;
      announce('合成候補 1：[' + RARITY_LABEL[picked.rarity] + '] ' + picked.name + ' / もう 1 個（同 rarity）を選択');
      return;
    }
    if (_mergePick === id) {
      _mergePick = null;
      announce('合成候補をクリアしました');
      return;
    }
    var res = mergeEquipment(_mergePick, id);
    _mergePick = null;
    if (res.ok) {
      announce('🎆 合成成功：[' + RARITY_LABEL[res.fused.rarity] + '] ' + res.fused.name);
    } else {
      announce('合成失敗：' + res.reason);
    }
    renderAll();
  }

  function announce(msg) {
    var el = document.getElementById('gameAnnounce');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  function renderTitles() {
    var box = document.getElementById('titleList');
    if (!box) return;
    var state = loadState();
    var have = {};
    (state.titles || []).forEach(function (t) { have[t.id] = t; });
    box.innerHTML = TITLES.map(function (def) {
      var got = have[def.id];
      return '<div class="title-item ' + (got ? 'unlocked' : 'locked') + '">' +
        '<span class="title-icon">' + (got ? '🏆' : '🔒') + '</span>' +
        '<span class="title-name">' + escapeHtml(def.name) + '</span>' +
        (got ? '<span class="title-date">' + new Date(got.unlockedAt).toLocaleDateString() + '</span>' : '') +
      '</div>';
    }).join('');
  }

  function renderRecords() {
    var box = document.getElementById('recordsList');
    if (!box) return;
    var state = loadState();
    var defeatedKeys = Object.keys(state.defeated || {});
    var recs = state.records || {};
    box.innerHTML =
      '<dl class="records-dl">' +
        '<dt>歴代最大ダメージ</dt><dd>' + (recs.bestDamage || 0) + '</dd>' +
        '<dt>最速勝利</dt><dd>' + (recs.fastestWinMs ? (recs.fastestWinMs / 1000).toFixed(2) + ' 秒' : '—') + '</dd>' +
        '<dt>最長連勝</dt><dd>' + (recs.longestStreak || 0) + '</dd>' +
        '<dt>撃破種類</dt><dd>' + defeatedKeys.length + ' / ' + ENEMIES.length + '</dd>' +
        '<dt>総バトル</dt><dd>' + (state.battlesPlayed || 0) + '</dd>' +
      '</dl>' +
      '<div class="defeated-grid">' + ENEMIES.map(function (e) {
        var d = state.defeated && state.defeated[e.id];
        var hidden = e.isHidden && !d;
        return '<div class="defeated-tile ' + (d ? 'on' : 'off') + ' ' + (hidden ? 'hidden' : '') + '">' +
          '<div class="d-name">' + (hidden ? '？？？' : escapeHtml(e.name)) + '</div>' +
          '<div class="d-meta">' + (d ? (d.count + '回 / 最高 ' + d.bestDmg + 'dmg') : (hidden ? '隠し' : '未撃破')) + '</div>' +
        '</div>';
      }).join('') + '</div>';
  }

  function renderAll() {
    var state = loadState();
    renderHud(state);
    renderWeeklyChallenge();
    renderEquipmentList();
    renderTitles();
    renderRecords();
    var bp = document.getElementById('prestigeBtn');
    if (bp) {
      var enable = (state.level || 1) >= PRESTIGE_LV_THRESHOLD;
      bp.disabled = !enable;
      bp.textContent = enable
        ? 'プレステージ実行（Lv → 1 / +15% 永続）'
        : 'プレステージは Lv ' + PRESTIGE_LV_THRESHOLD + ' から（現 Lv' + state.level + '）';
    }
  }

  // -------------------------------------------------------------
  // 18. 初期化（GAME タブの placeholder 撤去・パネル注入）
  // -------------------------------------------------------------
  function ensureUI() {
    var tabGame = document.getElementById('tab-game');
    if (!tabGame) return;
    if (tabGame.dataset.gameInitialized === '1') return;
    tabGame.dataset.gameInitialized = '1';

    // legacy-bridge は残置（v3.0.1 PASS への動線）
    // placeholder 3 枚（戦績/図鑑/チャート）は本実装に置換
    var placeholders = tabGame.querySelectorAll('.placeholder-card');
    placeholders.forEach(function (p) { p.remove(); });

    // メインパネル
    var html =
      '<div id="gameAnnounce" class="game-announce" aria-live="polite"></div>' +
      '<div id="gameHud" class="game-hud"></div>' +

      /* SS-3 v3.3.0：今週の挑戦セクション */
      '<div class="card-primary game-section weekly-challenge-card">' +
        '<div id="weeklyChallengePanel" class="weekly-challenge-panel"></div>' +
      '</div>' +

      '<div class="card-primary game-section">' +
        '<div class="card-title">⚔️ オートバトル</div>' +
        '<div class="muted-text small" style="margin-bottom:8px;">' +
          'ドラム神話系の妖怪と自動戦闘。観戦してニヤつく時間。' +
        '</div>' +
        '<div class="row">' +
          '<button class="btn-primary game-cta" id="autoBattleStartBtn" type="button">⚔️ オートバトル開始</button>' +
          '<button class="btn-secondary" id="chargeBtn" type="button">🔋 練習充電</button>' +
        '</div>' +
        '<div class="muted-text small" id="chargeMsg" style="margin-top:6px;"></div>' +
      '</div>' +

      '<div class="card-primary game-section">' +
        '<div class="card-title">🎰 装備ガチャ（30 🪙 or 30 🌟 / 1 回）</div>' +
        '<div class="row gacha-row">' +
          '<button class="btn-primary" id="gacha1Btn" type="button">🪙 1 連</button>' +
          '<button class="btn-secondary" id="gacha10Btn" type="button">🪙 10 連</button>' +
        '</div>' +
        // SS-6 還元星ガチャ（装備分解で得た 🌟 を消費）
        '<div class="row gacha-row" style="margin-top:6px;">' +
          '<button class="btn-secondary" id="gachaStars1Btn" type="button">🌟 1 連</button>' +
          '<button class="btn-secondary" id="gachaStars10Btn" type="button">🌟 10 連</button>' +
        '</div>' +
        '<div id="gachaResult" class="gacha-result"></div>' +
      '</div>' +

      '<div class="card-primary game-section">' +
        '<div class="card-title">🛡️ 装備</div>' +
        '<div class="muted-text small" style="margin-bottom:6px;">' +
          '同 rarity 2 個 → 上位 1 個に合成。装備するとオートバトル時に反映。' +
        '</div>' +
        '<div id="equipList" class="equip-list"></div>' +
      '</div>' +

      '<div class="card-primary game-section">' +
        '<div class="card-title">🏆 称号</div>' +
        '<div id="titleList" class="title-list"></div>' +
      '</div>' +

      '<div class="card-primary game-section">' +
        '<div class="card-title">📜 歴代記録 / 図鑑</div>' +
        '<div id="recordsList"></div>' +
      '</div>' +

      '<div class="card-secondary game-section">' +
        '<div class="card-title">★ プレステージ</div>' +
        '<div class="muted-text small" style="margin-bottom:6px;">' +
          'Lv ' + PRESTIGE_LV_THRESHOLD + ' 到達でリセット → 永続 +15% ボーナス。装備・コイン・称号は維持。' +
        '</div>' +
        '<button class="btn-primary" id="prestigeBtn" type="button" disabled>プレステージ</button>' +
      '</div>';

    tabGame.insertAdjacentHTML('beforeend', html);

    // バトルモーダル（body 末尾）
    var modal = document.createElement('div');
    modal.id = 'battleModal';
    modal.className = 'battle-modal';
    modal.innerHTML =
      '<div class="battle-modal-inner" role="dialog" aria-modal="true" aria-labelledby="battleEnemyName">' +
        '<div class="battle-head">' +
          '<button class="battle-close-x" id="battleXBtn" type="button" aria-label="閉じる">×</button>' +
        '</div>' +
        '<div class="battle-arena">' +
          '<div id="battleEnemyTile" class="battle-enemy-tile">' +
            '<div class="battle-enemy-glyph">👹</div>' +
            '<div class="battle-enemy-meta">' +
              '<div id="battleEnemyName" class="battle-enemy-name">—</div>' +
              '<div id="battleEnemyTitle" class="battle-enemy-title muted-text small">—</div>' +
            '</div>' +
            '<div class="hp-row">' +
              '<div class="hp-bar"><div id="battleEnemyHpBar" class="hp-bar-fill enemy"></div></div>' +
              '<span id="battleEnemyHpTxt" class="hp-txt">— / —</span>' +
            '</div>' +
          '</div>' +
          '<div class="battle-vs">VS</div>' +
          '<div class="battle-player-tile">' +
            '<div class="battle-player-glyph">🥁</div>' +
            '<div class="battle-player-meta">' +
              '<div class="battle-player-name">あなた</div>' +
              '<div class="muted-text small">観戦モード</div>' +
            '</div>' +
            '<div class="hp-row">' +
              '<div class="hp-bar"><div id="battlePlayerHpBar" class="hp-bar-fill player"></div></div>' +
              '<span id="battlePlayerHpTxt" class="hp-txt">— / —</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div id="battleLog" class="battle-log" role="log" aria-live="polite"></div>' +
        '<div id="battleFoot" class="battle-foot"></div>' +
      '</div>';
    document.body.appendChild(modal);

    // event hooks
    document.getElementById('autoBattleStartBtn').addEventListener('click', function () {
      openBattleUI({});
    });
    document.getElementById('chargeBtn').addEventListener('click', function () {
      var r = chargeFromPractice();
      var el = document.getElementById('chargeMsg');
      if (!r.ok) {
        if (el) el.textContent = '充電できませんでした：' + r.reason;
      } else if (r.xp === 0 && r.coins === 0) {
        if (el) el.textContent = '練習秒数が見つかりませんでした（emo lab で練習してから再挑戦）';
      } else {
        if (el) el.textContent = '🔋 ' + r.secCharged + ' 秒分を充電 → +' + r.xp + ' XP / +' + r.coins + ' 🪙';
      }
      renderAll();
    });
    document.getElementById('gacha1Btn').addEventListener('click', function () { runGacha(1, 'coins'); });
    document.getElementById('gacha10Btn').addEventListener('click', function () { runGacha(10, 'coins'); });
    // SS-6 還元星ガチャ
    var gs1 = document.getElementById('gachaStars1Btn');
    var gs10 = document.getElementById('gachaStars10Btn');
    if (gs1) gs1.addEventListener('click', function () { runGacha(1, 'stars'); });
    if (gs10) gs10.addEventListener('click', function () { runGacha(10, 'stars'); });
    document.getElementById('prestigeBtn').addEventListener('click', function () {
      var r = prestige();
      announce(r.ok ? '★ プレステージ ' + r.prestige + ' 達成！永続ボーナス更新' : 'プレステージ不可：' + r.reason);
      renderAll();
    });
    document.getElementById('battleXBtn').addEventListener('click', closeBattleUI);
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeBattleUI();
    });

    renderAll();
  }

  function runGacha(n, currency) {
    currency = currency === 'stars' ? 'stars' : 'coins';
    var box = document.getElementById('gachaResult');
    var results = gachaRoll(n, currency);
    if (!results.length) {
      if (box) {
        box.innerHTML = currency === 'stars'
          ? '<div class="muted-text small">還元星不足（30 🌟 必要・装備を分解して獲得）</div>'
          : '<div class="muted-text small">コイン不足（30 🪙 必要）</div>';
      }
      return;
    }
    if (box) {
      box.innerHTML = results.map(function (e) {
        var col = RARITY_COLOR[e.rarity];
        var rar = RARITY_LABEL[e.rarity];
        return '<div class="gacha-card" style="border-color:' + col + '">' +
          '<span class="gacha-rar" style="background:' + col + '">★' + rar + '</span>' +
          '<span class="gacha-name">' + escapeHtml(e.name) + '</span>' +
        '</div>';
      }).join('');
    }
    renderAll();
  }

  // -------------------------------------------------------------
  // 19. 公開 API
  // -------------------------------------------------------------
  global.SteadyGame = {
    __version: 'v3.2.0r2-block8-h5',
    AutoBattle: AutoBattle,
    autoBattle: autoBattle,
    loadState: loadState,
    saveState: saveState,
    computePlayerStats: computePlayerStats,
    levelForXp: levelForXp,
    gainXP: gainXP,
    gainCoins: gainCoins,
    chargeFromPractice: chargeFromPractice,
    dropEquipment: dropEquipment,
    gachaRoll: gachaRoll,
    /* SS-6 装備分解→還元星循環ループ API */
    disassembleEquipment: disassembleEquipment,
    DISASSEMBLE_STAR_TABLE: DISASSEMBLE_STAR_TABLE,
    GACHA_COST: GACHA_COST,
    mergeEquipment: mergeEquipment,
    equipItem: equipItem,
    unequipItem: unequipItem,
    unlockTitles: unlockTitles,
    prestige: prestige,
    pickEnemy: pickEnemy,
    /* SS-5 プレステ敵強化（×0.2/回） */
    instantiateEnemy: instantiateEnemy,
    PRESTIGE_ENEMY_SCALE_PER_LEVEL: PRESTIGE_ENEMY_SCALE_PER_LEVEL,
    /* SS-3 週替り挑戦 API */
    WEEKLY_CHALLENGE_POOL: WEEKLY_CHALLENGE_POOL,
    WEEKLY_CHALLENGE_MULTIPLIER: WEEKLY_CHALLENGE_MULTIPLIER,
    getWeekIndex: getWeekIndex,
    getCurrentWeeklyChallenge: getCurrentWeeklyChallenge,
    getWeeklyChallengeContext: getWeeklyChallengeContext,
    isWeeklyChallengeTarget: isWeeklyChallengeTarget,
    recordWeeklyHistory: recordWeeklyHistory,
    ENEMIES: ENEMIES,
    TITLES: TITLES,
    RARITY_LABEL: RARITY_LABEL,
    XP_GAIN: XP_GAIN,
    /* SS-4 装備スロット 3-5 可変解禁 API */
    SLOTS: SLOTS,
    SLOT_UNLOCK_LV: SLOT_UNLOCK_LV,
    SLOT_LABEL: SLOT_LABEL,
    EQUIP_NAMES: EQUIP_NAMES,
    unlockedSlots: unlockedSlots,
    ensureUI: ensureUI,
    renderAll: renderAll,
    openBattleUI: openBattleUI,
    closeBattleUI: closeBattleUI
  };

  // 自動 UI 注入
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureUI);
  } else {
    setTimeout(ensureUI, 0);
  }

})(typeof window !== 'undefined' ? window : globalThis);
