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
    spectating: null,          // 正在观战的座位号（null=未观战）
    killedBy: null,            // 淘汰我的对手座位号（客户端侧记录）
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
    G.dead = false; G.spectating = null; G.killedBy = null;
    $('battle').classList.remove('dead');
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
    if (G.spectating != null && G.peers[G.spectating]) renderSpectate(G.spectating);
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
    if (G.spectating === seat) {
      toast((G.seats[seat] ? G.seats[seat].name : '该玩家') + ' 已被淘汰');
      spectateNext();
    }
    if (seat === G.mySeat) {
      // 自己被淘汰：由服务器权威确认（m.by 或本地 G.killedBy）
      G.dead = true;
      if (G.syncTimer) { clearInterval(G.syncTimer); G.syncTimer = null; }
      if (G.game && G.game.stop) G.game.stop();   // 冻结本地棋盘，主棋盘随即被观战层/蒙层覆盖
      var killer = (G.killedBy != null) ? G.killedBy : m.by;
      $('battle').classList.add('dead');      // 让右侧缩略图浮于淘汰蒙层之上，可点击切换观战
      showEliminated(killer);
    }
  }

  function onOver(m) {
    G.over = true;
    if (specRAF) { cancelAnimationFrame(specRAF); specRAF = null; }
    if (G.syncTimer) { clearInterval(G.syncTimer); G.syncTimer = null; }
    if (G.game && G.game.stop) G.game.stop();          // 冻结本地棋盘，避免结算时棋盘仍在落块
    // 关闭观战视图与高亮，让结算层干净呈现
    G.spectating = null;
    var main = document.querySelector('.board.main');
    if (main) main.classList.remove('spectating');
    for (var k in G.thumbs) G.thumbs[k].wrap.classList.remove('spectating-now');
    var el = $('eliminated'); if (el) el.classList.remove('on');
    var sp = $('hSpectator'); if (sp) sp.style.display = 'none';
    showResult(m.winner === G.mySeat, m.ranking);
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
    $('specExit').onclick = exitSpectate;

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

    // 点击缩略图 → 进入观战
    wrap.addEventListener('click', function () { enterSpectate(seat); });

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

  /* ===================== 观战 ===================== */
  var specRenderer = null, specCtx = null, specDpr = 1, specRAF = null, specRunning = false;

  function setupSpectateRenderer() {
    var cv = $('spectateCanvas');
    if (!cv) return false;
    var cssW = cv.clientWidth, cssH = cv.clientHeight;
    if (cssW <= 0 || cssH <= 0) return false;
    specDpr = Math.min(global.devicePixelRatio || 1, 2.5);
    cv.width = Math.floor(cssW * specDpr); cv.height = Math.floor(cssH * specDpr);
    var cell = Math.floor(Math.min(cssW / 10, cssH / 20));
    if (cell < 2) return false;
    var offX = Math.floor((cssW - cell * 10) / 2), offY = Math.floor((cssH - cell * 20) / 2);
    specCtx = cv.getContext('2d');
    specRenderer = new TZ.Renderer(specCtx, { x: offX, y: offY, cell: cell, cols: 10, rows: 20, w: cssW, h: cssH });
    return true;
  }

  function renderSpectate(seat) {
    if (G.over) return;                        // 终局后不再渲染观战画面
    if (G.spectating == null || seat !== G.spectating) return;
    var peer = G.peers[seat];
    if (!peer) return;
    if (!specRenderer && !setupSpectateRenderer()) return;   // 画布尚未就绪，等下一帧重试
    // 整段包在 try 里：任何单帧渲染异常都不应让观战循环停摆（否则切换会卡住）
    try {
      var ctx = specCtx;
      ctx.setTransform(specDpr, 0, 0, specDpr, 0, 0);
      ctx.clearRect(0, 0, $('spectateCanvas').width, $('spectateCanvas').height);
      specRenderer.field();
      var rows = (peer.board || '').split('/').map(function (r) { return TZ.unpackRow(r); });
      specRenderer.thumbStack(rows);
      // 活动方块（跳过已有块的位置）
      var piece = peer.piece;
      if (piece && piece.t && TZ.SHAPES[piece.t] && TZ.COLORS[piece.t]) {
        var shape = TZ.SHAPES[piece.t][piece.r || 0];
        var color = TZ.COLORS[piece.t];
        var px = piece.x | 0, py = (piece.y | 0) - TZ.CFG.BUFFER;
        for (var k = 0; k < shape.length; k++) {
          var gx = shape[k][0] + px, gy = shape[k][1] + py;
          if (gy < 0 || gy >= rows.length) continue;
          if (gx < 0 || gx >= 10) continue;
          if (rows[gy] && rows[gy][gx] > 0) continue;               // 已有块 → 跳过
          specRenderer.block(gx, gy, color);
        }
      }
      var cured = computeCured(peer.board);
      if (cured > 0) specRenderer.curedLine(cured);

      // 信息头
      var s = G.seats[seat];
      var tgt = nextSeatOf(seat);
      var info = (s ? (s.avatar + ' ' + s.name) : '玩家') + ' #' + (seat + 1) +
        ' · ' + (peer.score || 0) + '分 · ' + (peer.lines || 0) + '行' +
        (peer.alive ? '' : ' · 出局') +
        (tgt >= 0 ? ' · 攻击 → #' + (tgt + 1) : '');
      var si = $('specInfo'); if (si) si.textContent = info;
    } catch (e) { /* 单帧渲染异常不影响后续切换 */ }
  }

  function enterSpectate(seat) {
    if (seat == null || seat === G.mySeat || !G.seats[seat]) return;
    G.spectating = seat;
    for (var k in G.thumbs) G.thumbs[k].wrap.classList.remove('spectating-now');
    if (G.thumbs[seat]) G.thumbs[seat].wrap.classList.add('spectating-now');
    var main = document.querySelector('.board.main');
    if (main) main.classList.add('spectating');
    var el = $('eliminated'); if (el) el.classList.remove('on');
    // 观战标识：在 HUD 区域显示（人多时显示人数）
    var sp = $('hSpectator');
    if (sp) {
      var myName = (ME ? ME.name : '你') || '你';
      sp.innerHTML = '<b>' + (myName.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')) + '</b> 正在观战';
      sp.style.display = '';
    }
    // 立即同步渲染一次（不依赖循环时序），再补一帧确保画布尺寸就绪
    renderSpectate(seat);
    requestAnimationFrame(function () { renderSpectate(seat); });
    // 启动 / 续接观战渲染循环：每帧按 G.spectating 重绘，切换对手自动生效
    if (!specRunning) { specRunning = true; spectateLoop(); }
    toast('观战中：' + (G.seats[seat] ? G.seats[seat].name : '#' + (seat + 1)));
  }

  /* 持续观战渲染循环：G.spectating 变化时自动切到新对手 */
  function spectateLoop() {
    if (G.spectating == null || G.over) { specRunning = false; specRAF = null; return; }
    renderSpectate(G.spectating);
    specRAF = requestAnimationFrame(spectateLoop);
  }

  function exitSpectate() {
    G.spectating = null;
    specRunning = false;
    if (specRAF) { cancelAnimationFrame(specRAF); specRAF = null; }
    var main = document.querySelector('.board.main');
    if (main) main.classList.remove('spectating');
    var sp = $('hSpectator'); if (sp) sp.style.display = 'none';
    if (G.dead) showEliminated(G.killedBy);   // 自己已出局 → 回到淘汰蒙层
  }

  function spectateNext() {
    // 选下一个存活对手（跳过自己）
    var cand = [];
    for (var i = 0; i < G.alive.length; i++) if (G.alive[i] !== G.mySeat) cand.push(G.alive[i]);
    if (!cand.length) { exitSpectate(); return; }
    // 从当前观战对象之后找
    var cur = (G.spectating == null) ? -1 : G.spectating;
    var idx = cand.indexOf(cur);
    var next = cand[(idx + 1) % cand.length];
    enterSpectate(next);
  }

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
    $('battle').classList.remove('dead');        // 解除 rail 置顶，避免压住结算层
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
      var main = document.querySelector('.board.main'); if (main) main.classList.remove('spectating');
      G.spectating = null; G.dead = false;
      $('battle').classList.remove('dead');
      G.net.send({ t: 'leave' });
      G.started = false; G.over = true; G.game = null;
      showScreen('screen-home');
    };
    $('resultBtn').onclick = function () {
      var main = document.querySelector('.board.main'); if (main) main.classList.remove('spectating');
      G.spectating = null; G.dead = false;
      $('battle').classList.remove('dead');
      $('result').className = '';
      showScreen('screen-home');
    };

    // 被淘汰蒙层按钮
    $('elimSpectate').onclick = function () {
      $('eliminated').classList.remove('on');
      // 默认观战：下一个存活对手（跳过自己）
      var cand = [];
      for (var i = 0; i < G.alive.length; i++) if (G.alive[i] !== G.mySeat) cand.push(G.alive[i]);
      if (cand.length) enterSpectate(cand[0]);
      else toast('暂无其他对手可观战');
    };
    $('elimHome').onclick = function () {
      $('eliminated').classList.remove('on');
      if (G.syncTimer) { clearInterval(G.syncTimer); G.syncTimer = null; }
      var main = document.querySelector('.board.main'); if (main) main.classList.remove('spectating');
      G.spectating = null; G.dead = false;
      $('battle').classList.remove('dead');
      G.net.send({ t: 'leave' });
      G.started = false; G.over = true; G.game = null;
      showScreen('screen-home');
    };

    global.addEventListener('resize', function () {
      if (G.started && !G.over) { layoutThumbs(); if (G.spectating != null) { specRenderer = null; setupSpectateRenderer(); renderSpectate(G.spectating); } }
    });

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
})(typeof window !== 'undefined' ? window : this);
