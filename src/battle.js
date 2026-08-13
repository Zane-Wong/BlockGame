/*!
 * ============================================================================
 *  魔方坠落 · 联机对战 — 客户端控制器
 * ----------------------------------------------------------------------------
 *  @file         src/battle.js
 *  @description  账号(浏览器指纹) / 房间流程 / 本地引擎接线 / 对手缩略图 / 网络事件
 *  @author       wangzhuo <mail_zhuo@163.com>
 * ============================================================================
 */
(function (global) {
  'use strict';
  var TZ = global.TZ;

  /* 开局前 N 毫秒内禁用「暂停」按钮（防止开局秒暂停），到点自动解锁 */
  var PAUSE_GRACE_MS = 30000;

  /* ===================== 账号：浏览器指纹 ===================== */
  var FP_KEY = 'tz_fp', PROF_KEY = 'tz_profile';
  function getFP() {
    var fp = localStorage.getItem(FP_KEY);
    if (!fp) { fp = 'fp_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(FP_KEY, fp); }
    return fp;
  }
  function getProfile() { var r = localStorage.getItem(PROF_KEY); return r ? JSON.parse(r) : null; }
  function saveProfile(p) { localStorage.setItem(PROF_KEY, JSON.stringify(p)); }

  var AVATARS = ['🦊', '🐼', '🐯', '🦁', '🐸', '🐵', '🐧', '🦉', '🐙', '🐲', '🦄', '🐱'];
  var ME = null;

  /* ===================== 全局状态 ===================== */
  var G = {
    net: null,
    fp: null,
    count: 4, code: '', seats: [], mySeat: -1, hostSeat: 0,
    alive: [],                 // 存活座位号数组（按座位序）
    started: false, over: false,
    dead: false,               // 本地玩家是否已被淘汰
    killedBy: null,            // 淘汰我的对手座位号（客户端侧记录）
    myPauseUsed: false,        // 本局我是否已用过暂停（每位仅一次）
    pauseActive: false,        // 当前是否有暂停进行中（任意玩家发起）
    pauseTimer: null,          // 暂停倒计时刷新定时器
    pauseUnlockAt: 0,          // 暂停按钮解锁时间戳（开局 30s 后才可用）
    pauseBtnTimer: null,       // 解锁倒计时刷新定时器
    game: null, syncTimer: null,
    thumbs: {},                // seat -> {wrap, cv, ctx, dpr, renderer}
    lastBoard: {},             // seat -> 最近一次快照的棋盘 packed（HUD 排名用）
    lastPiece: {},             // seat -> 最近一次快照的活动方块 {t,r,x,y}
    peers: {}                  // seat -> {alive,score,lines,board,piece} 最新快照缓存
  };

  /* ===================== DOM 工具 ===================== */
  function $(id) { return document.getElementById(id); }
  function showScreen(id) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) screens[i].classList.add('hidden');
    $('battle').classList.add('hidden');
    if (id) $(id).classList.remove('hidden');
  }
  function showBattle() {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) screens[i].classList.add('hidden');
    $('battle').classList.remove('hidden');
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('on'); }, 1800);
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ===================== 网络 ===================== */
  function connectNet() {
    G.net = new TZ.Net({});
    G.net.onOpen = function () { G.net.send({ t: 'hello', fp: G.fp, name: ME ? ME.name : '', avatar: ME ? ME.avatar : '' }); };
    G.net.onClose = function () { if (G.started && !G.over) toast('连接已断开'); };
    G.net.on('room', onRoom);
    G.net.on('start', onStart);
    G.net.on('snapshot', onSnapshot);
    G.net.on('attack', onAttack);
    G.net.on('dead', onDead);
    G.net.on('over', onOver);
    G.net.on('paused', onPaused);
    G.net.on('resume', onResume);
    G.net.on('error', function (m) { toast(m.msg || '出错了'); });
    G.net.connect();
  }

  function onRoom(m) {
    var s = m.state;
    G.code = s.code; G.count = s.count; G.seats = s.seats;
    if (s.you >= 0) G.mySeat = s.you;       // 广播消息 you=-1，不覆盖已有座位
    G.hostSeat = s.host; G.started = s.started;
    G.alive = [];
    for (var i = 0; i < s.seats.length; i++) if (s.seats[i] && s.seats[i].alive) G.alive.push(i);
    renderRoom();
    showScreen('screen-room');
  }

  function onStart(m) {
    G.started = true; G.over = false;
    G.dead = false; G.killedBy = null;
    G.myPauseUsed = false; G.pauseActive = false;       // 新一局：重置暂停机会与状态
    G.pauseUnlockAt = Date.now() + PAUSE_GRACE_MS;      // 开局 30s 内禁用暂停（防开局秒暂停）
    hidePauseMask();
    Spectate.reset();                                  // 清理上一局残留的观战状态
    G.lastBoard = {}; G.lastPiece = {}; G.peers = {};
    G.alive = [];
    for (var i = 0; i < G.seats.length; i++) if (G.seats[i]) G.alive.push(i);
    buildArena();
    showBattle();
    layoutThumbs();
    requestAnimationFrame(function () { layoutThumbs(); });
    // 关键修复：showBattle() 刚移除 display:none，浏览器尚未计算布局。
    // 必须等至少一帧（最好两帧：layout + paint）后再初始化游戏引擎，
    // 否则 #stage 的 clientWidth/clientHeight 为 0 → resize() 提前返回 → Canvas 永远 0×0。
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        startLocalGame();
      });
    });
    toast('对战开始！');
    updatePauseBtn();          // ← 关键修复：开局即刷新按钮状态（否则一直停留在初始 disabled）
    schedulePauseUnlock();     // 30s 后自动解锁暂停按钮
  }

  function onSnapshot(m) {
    if (G.over) return;                        // 终局后不再刷新任何棋盘/缩略图
    var players = m.state.players;
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      if (!p || i === G.mySeat) continue;
      G.lastBoard[i] = p.board;
      G.lastPiece[i] = p.piece;
      G.peers[i] = { alive: p.alive, score: p.score, lines: p.lines, board: p.board, piece: p.piece };
      renderThumb(i, p.board, p.piece, p.alive, p.score, p.lines);
    }
    // 观战画面由 Spectate.loop 每帧自管刷新，这里无需显式重绘
    updateHud();
  }

  function onAttack(m) {
    if (m.to === G.mySeat && G.game) {
      // 我被攻击：记录攻击者（用于被淘汰时显示"谁淘汰了我"），并在底部插入固化块
      G.killedBy = m.from;
      var overflow = G.game.board.addCured(m.lines);
      G.game.shake.add(10 + m.lines * 4);
      // 联机受击反馈：低沉受击音效 + 较强震动
      if (G.game.audio) G.game.audio.hurt(m.lines);
      if (navigator.vibrate) navigator.vibrate([30, 40, 70]);
      flashBoard();
      if (overflow) { G.game.gameOver(); }
    }
    // 对手的棋盘由各自的快照刷新；这里仅更新其存活/固化显示
  }

  function onDead(m) {
    var seat = m.seat;
    if (seat < 0) return;
    var idx = G.alive.indexOf(seat);
    if (idx >= 0) G.alive.splice(idx, 1);
    var t = G.thumbs[seat];
    if (t) t.wrap.classList.add('out');
    updateHud();
    // 正在观战的对象出局：提示并自动切换到下一个存活对手
    if (Spectate.target === seat) {
      toast((G.seats[seat] ? G.seats[seat].name : '该玩家') + ' 已被淘汰');
      Spectate.next();
    }
    if (seat === G.mySeat) {
      // 自己被淘汰：由服务器权威确认（m.by 或本地 G.killedBy）
      G.dead = true;
      if (G.syncTimer) { clearInterval(G.syncTimer); G.syncTimer = null; }
      if (G.game && G.game.stop) G.game.stop();   // 冻结本地棋盘，主棋盘随即被淘汰蒙层覆盖
      clearPauseBtnTimer();
      updatePauseBtn();                            // 出局后禁用暂停按钮
      var killer = (G.killedBy != null) ? G.killedBy : m.by;
      showEliminated(killer);
    }
  }

  function onOver(m) {
    G.over = true;
    clearPauseBtnTimer();
    if (G.syncTimer) { clearInterval(G.syncTimer); G.syncTimer = null; }
    if (G.game && G.game.stop) G.game.stop();          // 冻结本地棋盘，避免结算时棋盘仍在落块
    Spectate.reset();                                  // 关闭观战视图与高亮、隐藏 HUD 标识
    hidePauseMask();                                   // 兜底关闭遗留暂停蒙层
    var el = $('eliminated'); if (el) el.classList.remove('on');
    showResult(m.winner === G.mySeat, m.ranking);
  }

  /* ===================== 联机暂停 ===================== */
  /* 任一玩家发起暂停：所有玩家方块冻结 + 显示蒙版与倒计时；服务器权威计时。 */
  function onPaused(m) {
    if (G.over) return;
    G.pauseActive = true;
    if (m.by === G.mySeat) G.myPauseUsed = true;       // 我自己发起 → 本局暂停机会已用掉
    var who = (G.seats[m.by] ? G.seats[m.by].name : (m.name || '玩家'));
    var ava = (G.seats[m.by] && G.seats[m.by].avatar) ? G.seats[m.by].avatar : (m.avatar || '');
    var whoEl = $('pauseWho'); if (whoEl) whoEl.textContent = (ava ? ava + ' ' : '') + who;
    var mask = $('pauseMask'); if (mask) mask.classList.add('on');
    if (G.game && G.game.setFrozen) G.game.setFrozen(true);   // 冻结本地棋盘（重力/动画/手势停摆）
    updatePauseBtn();
    startPauseCountdown(m.until, m.dur || 30000);
  }

  function startPauseCountdown(until, dur) {
    if (G.pauseTimer) clearInterval(G.pauseTimer);
    var countEl = $('pauseCount');
    // 以服务器 until 为准；时钟异常时回退到本地 30s 时长
    var base = (until && until > Date.now() && until < Date.now() + (dur || 30000) + 10000)
      ? until : (Date.now() + (dur || 30000));
    function tickCount() {
      var rem = base - Date.now();
      var sec = (rem > 0) ? Math.max(0, Math.ceil(rem / 1000)) : 0;
      if (countEl) countEl.textContent = sec > 0 ? sec : '继续…';
      if (sec <= 0) { clearInterval(G.pauseTimer); G.pauseTimer = null; }
    }
    tickCount();
    G.pauseTimer = setInterval(tickCount, 200);
  }

  function onResume() {
    hidePauseMask();
    if (G.game && G.game.setFrozen) G.game.setFrozen(false);   // 解冻本地棋盘，方块继续下落
    G.pauseActive = false;
    updatePauseBtn();
  }

  function hidePauseMask() {
    if (G.pauseTimer) { clearInterval(G.pauseTimer); G.pauseTimer = null; }
    var mask = $('pauseMask'); if (mask) mask.classList.remove('on');
  }

  /* 暂停按钮可用性：
   *  - 对局中 + 未出局 + 无进行中暂停 + 本局未用过
   *  - 且需过「开局 30s 冷却期」（PAUSE_GRACE_MS）后才解锁
   * 冷却期内显示剩余秒数；用过一次后本局永久禁用。 */
  function updatePauseBtn() {
    var b = $('pauseBtn'); if (!b) return;
    var unlocked = Date.now() >= G.pauseUnlockAt;
    var can = G.started && !G.over && !G.dead && !G.pauseActive && !G.myPauseUsed && unlocked;
    b.disabled = !can;
    if (G.myPauseUsed) b.textContent = '已用过暂停';
    else if (!unlocked) b.textContent = '暂停(' + Math.max(0, Math.ceil((G.pauseUnlockAt - Date.now()) / 1000)) + 's)';
    else b.textContent = '暂停';
  }

  /* 开局前 30s：按钮置灰并显示剩余秒数；到点自动解锁 */
  function schedulePauseUnlock() {
    clearPauseBtnTimer();
    if (!G.started || G.over) { updatePauseBtn(); return; }
    if (Date.now() >= G.pauseUnlockAt) { updatePauseBtn(); return; }
    G.pauseBtnTimer = setInterval(function () {
      if (G.over || Date.now() >= G.pauseUnlockAt) clearPauseBtnTimer();
      updatePauseBtn();
    }, 300);
  }
  function clearPauseBtnTimer() {
    if (G.pauseBtnTimer) { clearInterval(G.pauseBtnTimer); G.pauseBtnTimer = null; }
  }

  /* ===================== 房间界面 ===================== */
  function renderRoom() {
    $('roomCode').textContent = G.code;
    var link = location.origin + location.pathname + '?room=' + encodeURIComponent(G.code);
    $('shareLink').value = link;
    var grid = $('seatGrid'); grid.innerHTML = '';
    for (var i = 0; i < G.count; i++) {
      var s = G.seats[i];
      var isMe = s && s.fp === G.fp;
      var seat = document.createElement('div');
      seat.className = 'seat' + (s ? ' occupied' : '') + (isMe ? ' mine' : '') + (s && s.bot ? ' bot' : '');
      if (s) {
        var tag = isMe ? '你' : (s.bot ? '🤖' : '#' + (i + 1));
        var nm = s.bot ? s.name : s.name;           // 机器人用服务端返回的实际名称（如"机器人 1"）
        seat.innerHTML = '<span class="tag">' + tag + '</span>' +
          '<span class="ava">' + s.avatar + '</span><span class="nm">' + nm + '</span>';
        if (s.bot) seat.innerHTML += '<span class="bot-label">AI</span>';
      } else {
        seat.innerHTML = '<span class="num">空位 #' + (i + 1) + '</span>';
      }
      (function (idx) { seat.onclick = function () { clickSeat(idx); }; })(i);
      grid.appendChild(seat);
    }
    var host = (G.mySeat === G.hostSeat);
    var seated = G.seats.filter(function (x) { return x; }).length;
    var hasEmpty = G.seats.some(function (x) { return !x; });
    var addBtn = $('addBotBtn');
    if (addBtn) addBtn.style.display = (host && !G.started && hasEmpty) ? '' : 'none';
    var sb = $('startBtn');
    sb.disabled = !host;
    if (!host) {
      sb.textContent = '等待房主开始…';
    } else if (seated < G.count) {
      sb.textContent = '开始对战（机器人补位 ' + (G.count - seated) + ' 人）';
    } else {
      sb.textContent = '开始对战';
    }
  }

  function clickSeat(i) {
    if (G.seats[i]) return;                 // 已占
    G.net.send({ t: 'sit', seat: i });       // 服务器会处理换座并广播
  }

  /* ===================== 对战舞台 ===================== */
  function buildArena() {
    var arena = $('arena');
    arena.innerHTML = '';
    arena.className = 'arena';

    // ── 主棋盘（本地引擎驱动，保持 20×10 等比）──
    var mainWrap = document.createElement('div');
    mainWrap.className = 'board main';
    var stage = document.createElement('div'); stage.id = 'stage';
    var board = document.createElement('canvas'); board.id = 'board';
    stage.appendChild(board);
    mainWrap.appendChild(stage);
    // 观战层：点击对手缩略图后，把被观战者的完整棋盘渲染在这里（覆盖主棋盘）
    var spec = document.createElement('div'); spec.id = 'spectate';
    spec.innerHTML = '<div class="spec-head">' +
      '<span class="spec-info" id="specInfo"></span>' +
      '<button class="spec-exit" id="specExit">退出观战</button></div>';
    var specCv = document.createElement('canvas'); specCv.id = 'spectateCanvas';
    spec.appendChild(specCv);
    mainWrap.appendChild(spec);
    arena.appendChild(mainWrap);
    // 必须在 appendChild 之后才能通过 $('specExit') 找到元素
    $('specExit').onclick = function () { Spectate.exit(); };

    // ── 对手缩略图轨道（竖列，攻击目标优先）──
    G.thumbs = {};
    var others = [];
    for (var i = 0; i < G.seats.length; i++) if (G.seats[i] && i !== G.mySeat) others.push(i);

    // 排序：攻击目标（nextSeatOf）排第一，其余按序号升序（环状）
    var target = nextSeatOf(G.mySeat);
    others.sort(function (a, b) {
      if (a === target) return -1;
      if (b === target) return 1;
      // 从 target+1 开始的环状顺序
      var da = (a - target + G.count) % G.count;
      var db = (b - target + G.count) % G.count;
      return da - db;
    });

    if (others.length > 0) {
      var rail = document.createElement('div');
      rail.className = 'rail';
      others.forEach(function (seat) { rail.appendChild(createOppBoard(seat)); });
      arena.appendChild(rail);
    }
  }

  function createOppBoard(seat) {
    var s = G.seats[seat];
    var wrap = document.createElement('div');
    wrap.className = 'board opp';
    if (s && s.bot) wrap.classList.add('bot');
    wrap.style.position = 'relative';
    wrap.dataset.seat = seat;
    wrap.title = '点击观战';

    var head = document.createElement('div');
    head.className = 'bhead';
    // 显示头像+名称 + 座位号角标（被观战时由 .spectating-now 显示「观战中」标签）
    head.innerHTML = '<span class="bname">' + (s.avatar + ' ' + s.name) + '</span>' +
      '<span class="bseat">#' + (seat + 1) + '</span>';
    var binfo = document.createElement('div');
    binfo.className = 'binfo';
    var cv = document.createElement('canvas');
    cv.className = 'tcanvas';
    var tag = document.createElement('div'); tag.className = 'target-tag'; tag.textContent = '你攻击 →';
    var atag = document.createElement('div'); atag.className = 'attacker-tag'; atag.textContent = '← 攻击我';
    wrap.appendChild(head); wrap.appendChild(binfo); wrap.appendChild(cv); wrap.appendChild(tag); wrap.appendChild(atag);

    // 点击事件改由 #app 上的「几何命中」统一处理器派发（见 connectNet 附近），
    // 不再此处挂监听 —— 避免某些环境下 click.target 落在 #app 而非缩略图导致切换失效。

    G.thumbs[seat] = { wrap: wrap, cv: cv, ctx: null, dpr: 1, renderer: null, binfo: binfo, seat: seat };
    return wrap;
  }

  function layoutThumbs() {
    for (var seat in G.thumbs) {
      var t = G.thumbs[seat]; var cv = t.cv;
      var cssW = cv.clientWidth, cssH = cv.clientHeight;
      if (cssW <= 0 || cssH <= 0) continue;
      var dpr = Math.min(global.devicePixelRatio || 1, 2.5);
      cv.width = Math.floor(cssW * dpr); cv.height = Math.floor(cssH * dpr);
      var cell = Math.floor(Math.min(cssW / 10, cssH / 20));
      if (cell < 2) continue;
      var offX = Math.floor((cssW - cell * 10) / 2), offY = Math.floor((cssH - cell * 20) / 2);
      t.dpr = dpr; t.ctx = cv.getContext('2d');
      t.renderer = new TZ.Renderer(t.ctx, { x: offX, y: offY, cell: cell, cols: 10, rows: 20, w: cssW, h: cssH });
    }
  }

  function renderThumb(seat, packed, piece, alive, score, lines) {
    var t = G.thumbs[seat];
    if (!t || !t.renderer) { layoutThumbs(); if (!t || !t.renderer) return; }
    var ctx = t.ctx;
    ctx.setTransform(t.dpr, 0, 0, t.dpr, 0, 0);
    ctx.clearRect(0, 0, t.cv.width, t.cv.height);
    var rows = (packed || '').split('/').map(function (r) { return TZ.unpackRow(r); });
    // 先画堆积块（含普通方块 + 固化带）
    t.renderer.thumbStack(rows);
    // 再画对手正在下落的活动方块（跳过已有块的位置，避免视觉穿透）
    if (piece && piece.t && TZ.SHAPES[piece.t] && TZ.COLORS[piece.t]) {
      var shape = TZ.SHAPES[piece.t][piece.r || 0];
      var color = TZ.COLORS[piece.t];
      var px = piece.x | 0, py = (piece.y | 0) - TZ.CFG.BUFFER;    // 转可见坐标
      for (var k = 0; k < shape.length; k++) {
        var gx = shape[k][0] + px;
        var gy = shape[k][1] + py;
        if (gy < 0 || gy >= rows.length) continue;                  // 越界不画
        if (gx < 0 || gx >= 10) continue;                           // 越界不画
        if (rows[gy] && rows[gy][gx] > 0) continue;                 // 该格已有块 → 跳过（避免穿透）
        t.renderer.block(gx, gy, color);
      }
    }
    var cured = computeCured(packed);
    if (cured > 0) t.renderer.curedLine(cured);
    if (t.binfo) t.binfo.textContent = '固化 ' + cured + '/20 · ' + (lines || 0) + '行';
    t.wrap.classList.toggle('out', !alive);
  }

  function computeCured(packed) {
    if (!packed) return 0;
    var rows = packed.split('/');
    var n = 0;
    for (var i = rows.length - 1; i >= 0; i--) {
      if (/^#+$/.test(rows[i])) n++; else break;
    }
    return n;
  }

  /* ===================== 本地引擎接线 ===================== */
  function battleUI() {
    return {
      setStats: function (score, level, lines) { /* HUD 主要看固化/排名，分数在缩略图 */ },
      renderNext: function (list) {
        var c = $('n0'); if (!c) return;
        var dpr = Math.min(global.devicePixelRatio || 1, 2.5);
        var r = c.getBoundingClientRect();
        var w = r.width || 34, h = r.height || 34;
        c.width = w * dpr; c.height = h * dpr;
        var cx = c.getContext('2d'); cx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (list && list[0]) TZ.Renderer.drawMini(cx, list[0], w, h);
        else cx.clearRect(0, 0, w, h);
      },
      hideOverlay: function () { },
      showStart: function () { },
      showTutorial: function () { },
      hideTutorial: function () { },
      showPause: function () { },
      showOver: function () { }
    };
  }

  function startLocalGame() {
    var canvas = $('board');
    var game = new TZ.Game({ canvas: canvas, ui: battleUI() });
    game.tutorial = null;
    game.onBattleClear = function (n) {
      // 自愈：挖掉自己一层固化块（若存在）
      if (game.board.cured > 0) game.board.digCured();
      G.net.send({ t: 'clear', lines: n });
      // 联机攻击反馈：我发动攻击（消行即攻击下一对手）
      if (game.audio) game.audio.attack(n);
      if (navigator.vibrate) navigator.vibrate(20);
    };
    game.onGameOver = function (score, lines, best) {
      G.net.send({ t: 'dead' });
      if (G.syncTimer) { clearInterval(G.syncTimer); G.syncTimer = null; }
    };
    G.game = game;

    // 强制 resize：确保 Canvas 物理像素已正确设置（依赖 #stage 已有确定尺寸）
    game.resize();
    // 防御：如果 #stage 尺寸仍为 0（极端情况），用 rAF 重试
    if (canvas.width <= 0 || canvas.height <= 0) {
      requestAnimationFrame(function () { game.resize(); });
    }

    game.start();
    game.loop();                              // ← 启动游戏循环（requestAnimationFrame + draw）
    G.syncTimer = setInterval(sendSync, 160);
  }

  function sendSync() {
    if (!G.started || G.over || !G.game) return;
    var p = G.game.piece;
    var payload = { t: 'sync', board: TZ.packBoard(G.game.board), score: G.game.score, lines: G.game.lines };
    if (p) payload.piece = { t: p.type, r: p.rot, x: p.x, y: p.y };   // 活动方块（绝对坐标，供对手缩略图渲染）
    G.net.send(payload);
  }

  function flashBoard() {
    var arena = $('arena');
    arena.animate([{ filter: 'brightness(2.2)' }, { filter: 'brightness(1)' }], { duration: 260 });
  }

  /* ===================== HUD ===================== */
  function nextSeatOf(seat) {
    var a = G.alive;
    if (a.length <= 1) return -1;
    var idx = a.indexOf(seat);
    if (idx < 0) return a[0];
    return a[(idx + 1) % a.length];
  }

  function updateHud() {
    var alive = G.alive.length;
    $('hAlive').textContent = alive;
    if (G.game) $('hSolid').textContent = G.game.board.cured + '/20';

    // 排名：按「剩余可用高度」= 20 - 固化 排序；对手固化取自缓存的棋盘快照
    var list = [];
    for (var i = 0; i < G.seats.length; i++) {
      if (!G.seats[i]) continue;
      var aliveHere = G.alive.indexOf(i) >= 0;
      var cured = (i === G.mySeat && G.game) ? G.game.board.cured : computeCured(G.lastBoard[i] || '');
      list.push({ seat: i, alive: aliveHere, space: 20 - cured });
    }
    list.sort(function (a, b) { if (a.alive !== b.alive) return a.alive ? -1 : 1; return b.space - a.space; });
    var myRank = -1;
    for (var k = 0; k < list.length; k++) if (list[k].seat === G.mySeat) myRank = k + 1;
    $('hRank').textContent = (myRank > 0 ? myRank : '-') + '/' + alive;

    var t = nextSeatOf(G.mySeat);
    var tEl = $('hTarget');
    if (t >= 0 && G.seats[t]) tEl.textContent = '攻击 → #' + (t + 1) + ' ' + G.seats[t].name;
    else tEl.textContent = '攻击 → —';
    tEl.parentElement.classList.toggle('target', t >= 0);

    // 谁在攻击我：攻击环中位于我之前一位的存活座位
    var a = attackerOf(G.mySeat);
    var aEl = $('hAttacker');
    if (aEl) {
      if (a >= 0 && G.seats[a]) aEl.textContent = '← 被 #' + (a + 1) + ' ' + G.seats[a].name + ' 攻击';
      else aEl.textContent = '← 被 — 攻击';
      aEl.parentElement.classList.toggle('attacker', a >= 0);
    }

    // 高亮「我正在攻击的对手」与「正在攻击我的对手」
    for (var s in G.thumbs) {
      var sn = parseInt(s, 10);
      G.thumbs[s].wrap.classList.toggle('attacked', sn === t);
      G.thumbs[s].wrap.classList.toggle('attacker', sn === a);
    }
  }

  /* 攻击环中「攻击 seat 的人」：存活环里 seat 的前一位 */
  function attackerOf(seat) {
    var a = G.alive;
    if (a.length <= 1) return -1;
    var idx = a.indexOf(seat);
    if (idx < 0) return a[a.length - 1];
    return a[(idx - 1 + a.length) % a.length];
  }

  /* ===================== 观战模块 ===================== *
   * 状态：
   *   active  —— 是否处于观战态（被淘汰后点「观战剩余对局」进入）
   *   target  —— 正在观战的座位号（null = 未观战）
   * 入口：
   *   enter(seat)  指定对手进入观战（点击右侧缩略图任意处触发；可在已观战时切换）
   *   next()       被观战者出局时自动切到下一个存活对手
   *   exit()       退出观战（回到「被淘汰」蒙层）
   *   reset()      彻底停止（游戏结束 / 返回首页），不弹蒙层
   * 渲染：
   *   loop()       每帧重绘当前 target 的棋盘（活动方块随快照实时刷新）
   * 标识：
   *   setBadge()   在 HUD 显示「xxx 正在观战」（多人观战时显示「N人正在观战」）
   * ===================================================== */
  var Spectate = {
    active: false, target: null,
    renderer: null, ctx: null, dpr: 1, raf: null, running: false,

    /* 进入 / 切换观战对象 */
    enter: function (seat) {
      if (G.over) return;
      if (seat == null || seat === G.mySeat || !G.seats[seat]) return;
      var switching = (this.active && this.target !== seat);
      this.target = seat;
      this.active = true;
      // 高亮当前观战对象（平静青色描边 + 「观战中」标签）
      for (var k in G.thumbs) if (G.thumbs[k].wrap) G.thumbs[k].wrap.classList.remove('spectating-now');
      if (G.thumbs[seat]) G.thumbs[seat].wrap.classList.add('spectating-now');
      var main = document.querySelector('.board.main');
      if (main) main.classList.add('spectating');
      // —— 兜底显隐：内联 style 优先级最高，杜绝 CSS 级联未生效导致主棋盘残留 ——
      // 1) 强制 #spectate 从 display:none 切到 display:flex
      // 2) 强制 #stage 不可见（保留布局但隐藏内含棋盘）
      // 3) offsetHeight 读取引发浏览器同步回流，#spectate 的 clientWidth/Height 下次读取即为真实尺寸
      var spec = $('spectate'); var stage = $('stage');
      if (spec) { spec.style.display = 'flex'; spec.offsetHeight; }
      if (stage) { stage.style.visibility = 'hidden'; }
      // 隐藏「被淘汰」蒙层（若仍显示）
      var el = $('eliminated'); if (el) el.classList.remove('on');
      this.setBadge();
      // 强制同步测量 canvas 尺寸（getBoundingClientRect 已自带回流），并立即绘制首帧
      this.ensureSetup();
      this.render();
      this.ensureLoop();
      toast((switching ? '切换观战：' : '观战中：') + (G.seats[seat] ? G.seats[seat].name : '#' + (seat + 1)));
    },

    /* 被观战者出局 → 自动跳到下一个存活对手；无则退出 */
    next: function () {
      var cand = [];
      for (var i = 0; i < G.alive.length; i++) if (G.alive[i] !== G.mySeat) cand.push(G.alive[i]);
      if (!cand.length) { this.exit(); return; }
      var cur = (this.target == null) ? -1 : this.target;
      var idx = cand.indexOf(cur);
      var nxt = cand[(idx + 1) % cand.length];
      this.enter(nxt);
    },

    /* 退出观战：回到「被淘汰」蒙层（若自己已出局） */
    exit: function () {
      this.reset();
      if (G.dead) showEliminated(G.killedBy);
    },

    /* 彻底停止观战（不弹蒙层）：游戏结束 / 返回首页 */
    reset: function () {
      this.active = false; this.target = null;
      this.stopLoop();
      var main = document.querySelector('.board.main');
      if (main) main.classList.remove('spectating');
      // —— 兜底恢复：内联 style 清空，回到 CSS 默认（display:none） ——
      var spec = $('spectate'); var stage = $('stage');
      if (spec) spec.style.display = '';
      if (stage) stage.style.visibility = '';
      for (var k in G.thumbs) if (G.thumbs[k].wrap) G.thumbs[k].wrap.classList.remove('spectating-now');
      var sp = $('hSpectator'); if (sp) sp.style.display = 'none';
    },

    /* HUD 标识：当前仅本地玩家观战；多人同时观战时可传 count 显示「N人正在观战」 */
    setBadge: function (count) {
      var sp = $('hSpectator');
      if (!sp) return;
      if (!this.active) { sp.style.display = 'none'; return; }
      var name = (ME ? ME.name : '你') || '你';
      sp.innerHTML = (count && count > 1)
        ? (count + '人正在观战')
        : ('<b>' + escapeHtml(name) + '</b> 正在观战');
      sp.style.display = '';
    },

    ensureSetup: function () {
      if (this.renderer) return true;
      var cv = $('spectateCanvas');
      if (!cv) return false;
      // 强制浏览器同步回流：display:none→flex 后 clientWidth 可能仍为 0
      var rect = cv.getBoundingClientRect();
      var cssW = rect.width || cv.clientWidth, cssH = rect.height || cv.clientHeight;
      if (cssW <= 0 || cssH <= 0) return false;
      this.dpr = Math.min(global.devicePixelRatio || 1, 2.5);
      cv.width = Math.floor(cssW * this.dpr); cv.height = Math.floor(cssH * this.dpr);
      var cell = Math.floor(Math.min(cssW / 10, cssH / 20));
      if (cell < 2) return false;
      var offX = Math.floor((cssW - cell * 10) / 2), offY = Math.floor((cssH - cell * 20) / 2);
      this.ctx = cv.getContext('2d');
      this.renderer = new TZ.Renderer(this.ctx, { x: offX, y: offY, cell: cell, cols: 10, rows: 20, w: cssW, h: cssH });
      return true;
    },

    ensureLoop: function () { if (this.running) return; this.running = true; this.loop(); },
    stopLoop: function () { this.running = false; if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; } },
    loop: function () {
      if (!this.running || !this.active || G.over) { this.running = false; this.raf = null; return; }
      this.render();
      var self = this;
      this.raf = requestAnimationFrame(function () { self.loop(); });
    },

    render: function () {
      if (G.over || !this.active || this.target == null) return;
      var seat = this.target;
      // 优先用 peers（完整快照），后备 lastBoard/lastPiece（与缩略图同源，更可靠）
      var peer = G.peers[seat] || {};
      var board = peer.board || G.lastBoard[seat] || '';
      var piece = peer.piece || G.lastPiece[seat] || null;
      // 无数据时画提示文字而非静默返回空白
      if (!board && !piece) {
        this._drawNoData('等待数据…');
        return;
      }
      try {
        if (!this.ensureSetup()) { this._drawNoData('画布未就绪'); return; }
        var ctx = this.ctx;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, $('spectateCanvas').width, $('spectateCanvas').height);
        this.renderer.field();
        var rows = (board || '').split('/').map(function (r) { return TZ.unpackRow(r); });
        this.renderer.thumbStack(rows);
        // 活动方块（跳过已有块的位置）
        if (piece && piece.t && TZ.SHAPES[piece.t] && TZ.COLORS[piece.t]) {
          var shape = TZ.SHAPES[piece.t][piece.r || 0];
          var color = TZ.COLORS[piece.t];
          var px = piece.x | 0, py = (piece.y | 0) - TZ.CFG.BUFFER;
          for (var k = 0; k < shape.length; k++) {
            var gx = shape[k][0] + px, gy = shape[k][1] + py;
            if (gy < 0 || gy >= rows.length) continue;
            if (gx < 0 || gx >= 10) continue;
            if (rows[gy] && rows[gy][gx] > 0) continue;
            this.renderer.block(gx, gy, color);
          }
        }
        var cured = computeCured(board);
        if (cured > 0) this.renderer.curedLine(cured);
        // 信息头
        var s = G.seats[seat];
        var tgt = nextSeatOf(seat);
        var info = (s ? (s.avatar + ' ' + s.name) : '玩家') + ' #' + (seat + 1) +
          ' · ' + (peer.score || 0) + '分 · ' + (peer.lines || 0) + '行' +
          ((peer != null && peer.alive === false) ? ' · 出局' : '') +
          (tgt >= 0 ? ' · 攻击 → #' + (tgt + 1) : '');
        var si = $('specInfo'); if (si) si.textContent = info;
      } catch (e) {
        /* 单帧异常不影响后续切换 */
        this._drawNoData('渲染异常');
      }
    },

    /* 数据不可用时在画布中央显示提示文字 */
    _drawNoData: function (msg) {
      try {
        if (!this.ensureSetup()) return;
        var ctx = this.ctx;
        var cv = $('spectateCanvas');
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.font = '14px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(msg, cv.width / this.dpr / 2, cv.height / this.dpr / 2);
      } catch (e) { /* 静默 */ }
    },
  };

  /* ===================== 被淘汰结算蒙层 ===================== */
  function showEliminated(bySeat) {
    var ov = $('eliminated');
    if (!ov) return;
    var killer = (bySeat != null) ? G.seats[bySeat] : null;
    var kt = $('elimKiller');
    if (killer) {
      kt.innerHTML = '<span class="ek-ava">' + killer.avatar + '</span>' +
        '<span class="ek-txt">由 <b>' + killer.name + '</b> (#' + (bySeat + 1) + ') 送你出局</span>';
    } else {
      kt.innerHTML = '<span class="ek-txt">你的棋盘被固化块压满了</span>';
    }
    ov.classList.add('on');
  }

  /* ===================== 结算 ===================== */
  function showResult(win, ranking) {
    var ov = $('result');
    ov.className = 'on ' + (win ? 'win' : 'lose');
    $('resultTitle').textContent = win ? 'VICTORY' : 'DEFEAT';
    $('resultDesc').textContent = win ? '你是最后的幸存者！' : '对战结束，看看你的名次 →';
    var listEl = $('rankList');
    listEl.innerHTML = '';
    var list = (ranking && ranking.length) ? ranking : buildLocalRanking();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var isMe = (p.seat === G.mySeat);
      var medal = p.place === 1 ? '🥇' : p.place === 2 ? '🥈' : p.place === 3 ? '🥉' : ('#' + p.place);
      var row = document.createElement('div');
      row.className = 'rank-row' + (p.alive ? ' alive' : '') + (isMe ? ' me' : '') + (p.place === 1 ? ' win' : '');
      row.innerHTML =
        '<span class="rk-medal">' + medal + '</span>' +
        '<span class="rk-ava">' + p.avatar + '</span>' +
        '<span class="rk-name">' + p.name +
        (p.bot ? ' <span class="rk-bot">AI</span>' : '') +
        (isMe ? ' <span class="rk-me">你</span>' : '') + '</span>' +
        '<span class="rk-stat">' + (p.score || 0) + '分 · ' + (p.lines || 0) + '行</span>';
      listEl.appendChild(row);
    }
  }

  /* 服务器未带排行时的兜底：按当前存活状态 + 分数排序 */
  function buildLocalRanking() {
    var list = [];
    for (var i = 0; i < G.seats.length; i++) {
      if (!G.seats[i]) continue;
      var alive = G.alive.indexOf(i) >= 0;
      list.push({
        seat: i, name: G.seats[i].name, avatar: G.seats[i].avatar, bot: !!G.seats[i].bot,
        score: G.peers[i] ? G.peers[i].score : 0,
        lines: G.peers[i] ? G.peers[i].lines : 0,
        alive: alive
      });
    }
    list.sort(function (a, b) { if (a.alive !== b.alive) return a.alive ? -1 : 1; return (b.score || 0) - (a.score || 0); });
    for (var k = 0; k < list.length; k++) list[k].place = k + 1;
    return list;
  }

  /* ===================== 流程按钮接线 ===================== */
  function boot() {
    G.fp = getFP();
    ME = getProfile();

    // 头像选择
    var av = $('avatars');
    AVATARS.forEach(function (a, i) {
      var d = document.createElement('div');
      d.className = 'av' + (i === 0 ? ' sel' : '');
      d.textContent = a; d.dataset.a = a;
      d.onclick = function () { av.querySelectorAll('.av').forEach(function (x) { x.classList.remove('sel'); }); d.classList.add('sel'); };
      av.appendChild(d);
    });
    $('fpText').textContent = '浏览器身份指纹: ' + G.fp;

    $('saveProfile').onclick = function () {
      var name = ($('initName').value || '玩家').trim().slice(0, 8);
      var avatar = document.querySelector('#avatars .av.sel').dataset.a;
      ME = { name: name, avatar: avatar }; saveProfile(ME);
      enterHome();
    };

    $('goCreate').onclick = function () { G.count = 4; $('cCount').textContent = 4; showScreen('screen-count'); };
    $('goJoin').onclick = function () { $('joinCode').value = ''; showScreen('screen-join'); };
    $('cMinus').onclick = function () { G.count = Math.max(2, G.count - 1); $('cCount').textContent = G.count; };
    $('cPlus').onclick = function () { G.count = Math.min(9, G.count + 1); $('cCount').textContent = G.count; };
    $('doCreate').onclick = function () { G.net.send({ t: 'create', count: G.count, fp: G.fp, name: ME ? ME.name : '', avatar: ME ? ME.avatar : '' }); };
    $('cBack').onclick = function () { showScreen('screen-home'); };
    $('doJoin').onclick = function () {
      var code = ($('joinCode').value || '').trim().toUpperCase();
      if (!code) { toast('请输入房间码'); return; }
      G.net.send({ t: 'join', code: code, fp: G.fp, name: ME ? ME.name : '', avatar: ME ? ME.avatar : '' });
    };
    $('jBack').onclick = function () { showScreen('screen-home'); };
    $('copyLink').onclick = function () {
      var inp = $('shareLink'); inp.select();
      if (navigator.clipboard) navigator.clipboard.writeText(inp.value);
      $('copyLink').textContent = '已复制'; setTimeout(function () { $('copyLink').textContent = '复制'; }, 1200);
    };
    $('startBtn').onclick = function () { G.net.send({ t: 'start' }); };
    $('addBotBtn').onclick = function () { G.net.send({ t: 'addbot' }); };
    $('roomBack').onclick = function () { G.net.send({ t: 'leave' }); showScreen('screen-home'); };
    $('backHome').onclick = function () {
      if (G.syncTimer) { clearInterval(G.syncTimer); G.syncTimer = null; }
      Spectate.reset(); G.dead = false;
      G.myPauseUsed = false; G.pauseActive = false; hidePauseMask();
      clearPauseBtnTimer();
      G.net.send({ t: 'leave' });
      G.started = false; G.over = true; G.game = null;
      showScreen('screen-home');
    };
    $('pauseBtn').onclick = function () {
      if (!G.started || G.over || G.dead || G.pauseActive || G.myPauseUsed) return;
      G.net.send({ t: 'pause' });
    };
    $('resultBtn').onclick = function () {
      Spectate.reset(); G.dead = false;
      G.myPauseUsed = false; G.pauseActive = false; hidePauseMask();
      clearPauseBtnTimer();
      $('result').className = '';
      showScreen('screen-home');
    };

    // 被淘汰蒙层按钮
    $('elimSpectate').onclick = function () {
      $('eliminated').classList.remove('on');
      // 默认观战：第一个存活对手（跳过自己）
      var cand = [];
      for (var i = 0; i < G.alive.length; i++) if (G.alive[i] !== G.mySeat) cand.push(G.alive[i]);
      if (cand.length) Spectate.enter(cand[0]);
      else toast('暂无其他对手可观战');
    };
    $('elimHome').onclick = function () {
      $('eliminated').classList.remove('on');
      if (G.syncTimer) { clearInterval(G.syncTimer); G.syncTimer = null; }
      Spectate.reset(); G.dead = false;
      G.myPauseUsed = false; G.pauseActive = false; hidePauseMask();
      clearPauseBtnTimer();
      G.net.send({ t: 'leave' });
      G.started = false; G.over = true; G.game = null;
      showScreen('screen-home');
    };

    global.addEventListener('resize', function () {
      if (G.started && !G.over) {
        layoutThumbs();
        if (Spectate.active) { Spectate.renderer = null; Spectate.ensureSetup(); Spectate.render(); }   // 重新测量观战画布
      }
    });

    // ── 观战切换：以「坐标几何命中」统一派发，彻底绕开层叠/事件目标异常 ──
    // 实测某些移动端环境下，点击缩略图时 event.target 落在 #app 而非缩略图，
    // 导致直接挂在其上的监听器收不到事件。改用挂在 #app 上的统一处理器，
    // 用 clientX/clientY 与缩略图真实 getBoundingClientRect() 判定点了哪个对手。
    var appEl = $('app');
    if (appEl) {
      appEl.addEventListener('click', function (e) {
        if (!G.dead && !Spectate.active) return;        // 仅被淘汰后 / 已在观战中时可切换
        var elim = $('eliminated');
        if (elim && elim.classList.contains('on')) return;   // 蒙层仍显示时，让蒙层按钮正常工作
        if (!G.thumbs || !G.seats) return;
        var x = e.clientX, y = e.clientY;
        for (var s in G.thumbs) {
          if (!G.thumbs.hasOwnProperty(s)) continue;
          var seat = parseInt(s, 10);
          if (seat === G.mySeat || !G.seats[seat]) continue;
          var r = G.thumbs[seat].wrap.getBoundingClientRect();
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            Spectate.enter(seat);
            return;
          }
        }
      });
    }

    connectNet();

    // 路由：新玩家 → 初始化；老玩家 → 首页
    var params = new URLSearchParams(location.search);
    var roomParam = params.get('room');
    if (!ME) { showScreen('screen-init'); }
    else { enterHome(); if (roomParam) { G.net.send({ t: 'join', code: roomParam.toUpperCase(), fp: G.fp, name: ME.name, avatar: ME.avatar }); } }
  }

  function enterHome() {
    if (!ME) ME = getProfile();
    $('curName').textContent = (ME ? ME.name : '—') + (ME ? ' ' + ME.avatar : '');
    showScreen('screen-home');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  TZ.Battle = G;

  // 初始禁用暂停按钮（未开局前不可用）
  updatePauseBtn();
})(typeof window !== 'undefined' ? window : this);
