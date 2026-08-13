/*!
 * ============================================================================
 *  魔方坠落 · 联机对战 — 服务器入口
 * ----------------------------------------------------------------------------
 *  @file         server/index.js
 *  @description  HTTP 静态托管 + WebSocket 升级 + 房间/对战消息路由
 *  @author       wangzhuo <mail_zhuo@163.com>
 * ============================================================================
 *
 *  运行：node server/index.js   （零外部依赖）
 *  默认端口 8080，可用环境变量 PORT 覆盖。
 */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');
var ws = require('./ws.js');
var RoomManager = require('./room.js').RoomManager;
var BotEngine = require('./botengine.js').BotEngine;

var ROOT = path.resolve(__dirname, '..');
var PORT = parseInt(process.env.PORT, 10) || 8080;

/* 联机暂停时长（毫秒）。默认 30 秒；可用环境变量 PR_PAUSE_MS 覆盖（测试时调小以加速验证）。 */
var PR_PAUSE_MS = parseInt(process.env.PR_PAUSE_MS, 10);
if (!(PR_PAUSE_MS >= 1000)) PR_PAUSE_MS = 30000;

var mgr = new RoomManager();
var clients = new Set();           // 所有连接
var dirtyRooms = new Set();        // 待推送快照的房间

/* ---------- 工具 ---------- */
function rand() { return Math.random().toString(36).slice(2, 8); }

function broadcast(room, msg, exceptConn) {
  var payload = JSON.stringify(msg);
  clients.forEach(function (c) {
    if (c.roomCode === room.code && !c.closed && c !== exceptConn) {
      try { c.send(JSON.parse(payload)); } catch (e) { /* ignore */ }
    }
  });
}

function markDirty(room) { dirtyRooms.add(room.code); }

/* 房间里是否还有真实玩家（机器人不算） */
function roomHasHuman(room) {
  for (var i = 0; i < room.seats.length; i++) {
    var s = room.seats[i];
    if (s && !s.bot) return true;
  }
  return false;
}

/* 清空房间的暂停定时器与暂停态（房间解散时调用，避免遗留定时器误触发 resume） */
function clearRoomPause(room) {
  if (room && room._pauseTimer) { clearTimeout(room._pauseTimer); room._pauseTimer = null; }
  if (room) room.pause = null;
}

/* 统一结算一次攻击：广播 attack，并对「机器人受害者」真实累固化块 / 判负。
 * 人类受害者由各自客户端收到 attack 后自行插入固化块，无需服务器记账。
 * 同时记录受害者的 lastAttacker（用于被淘汰时显示"谁淘汰了我"）。 */
function deliverAttack(room, from, to, lines) {
  broadcast(room, { t: 'attack', from: from, to: to, lines: lines });
  var v = room.seats[to];
  if (v) v.lastAttacker = from;
  if (v && v.bot && v.engine) {
    var overflow = v.engine.addCured(lines);
    v.cured = v.engine.board.cured;
    if (overflow) {
      v.alive = false;
      v.engine.dead = true;
      room._recordDeath(to);
      broadcast(room, { t: 'dead', seat: to, by: from });
      var res = room.checkWin();
      if (res.over) broadcast(room, { t: 'over', winner: res.winner, ranking: room.buildRanking(res.winner) });
    } else {
      markDirty(room);
    }
  }
}

function leave(conn) {
  if (!conn.roomCode) return;
  var room = mgr.get(conn.roomCode);
  if (!room) { conn.roomCode = null; conn.seat = -1; return; }
  var r = room.removePlayer(conn.fp);
  var wasHost = (conn.seat === room.hostSeat);
  conn.roomCode = null; conn.seat = -1;

    if (r.started) {
      var res = room.checkWin();
      broadcast(room, { t: 'dead', seat: r.seat });
      if (res.over) broadcast(room, { t: 'over', winner: res.winner, ranking: room.buildRanking(res.winner) });
      if (!roomHasHuman(room)) { clearRoomPause(room); mgr.drop(room.code); }   // 没有真实玩家 → 散场（避免机器人空转）
  } else {
    // 房主离开 → 转让给首个仍在的真实玩家（跳过机器人）
    if (wasHost) {
      for (var i = 0; i < room.seats.length; i++) {
        if (room.seats[i] && !room.seats[i].bot) { room.hostSeat = i; break; }
      }
    }
    if (!roomHasHuman(room)) mgr.drop(room.code);
    else broadcast(room, { t: 'room', state: room.roomState(-1) });
  }
}

/* ---------- 消息路由 ---------- */
function handle(conn, msg) {
  if (!msg || !msg.t) return;
  switch (msg.t) {
    case 'hello':
      if (msg.fp) conn.fp = msg.fp;
      if (msg.name) conn.meta.name = msg.name;
      if (msg.avatar) conn.meta.avatar = msg.avatar;
      conn.send({ t: 'welcome', id: conn.fp });
      break;

    case 'create': {
      if (conn.roomCode) leave(conn);
      var room = mgr.create(msg.count);
      conn.fp = (msg.fp || conn.fp || ('fp_' + rand()));
      conn.meta.name = msg.name || conn.meta.name;
      conn.meta.avatar = msg.avatar || conn.meta.avatar;
      conn.seat = room.addPlayer(conn.fp, conn.meta.name, conn.meta.avatar);
      conn.roomCode = room.code;
      conn.send({ t: 'room', state: room.roomState(conn.seat) });
      broadcast(room, { t: 'room', state: room.roomState(-1) }, conn);
      console.log('[create] %s count=%d by %s', room.code, room.count, conn.fp);
      break;
    }

    case 'join': {
      var jr = mgr.get(msg.code);
      if (!jr) { conn.send({ t: 'error', msg: '房间不存在' }); return; }
      if (conn.roomCode) leave(conn);
      conn.fp = (msg.fp || conn.fp || ('fp_' + rand()));
      conn.meta.name = msg.name || conn.meta.name;
      conn.meta.avatar = msg.avatar || conn.meta.avatar;
      var s = jr.addPlayer(conn.fp, conn.meta.name, conn.meta.avatar);
      if (s < 0) { conn.send({ t: 'error', msg: '房间已满' }); return; }
      conn.roomCode = jr.code; conn.seat = s;
      conn.send({ t: 'room', state: jr.roomState(s) });
      broadcast(jr, { t: 'room', state: jr.roomState(-1) }, conn);
      console.log('[join] %s seat=%d by %s', jr.code, s, conn.fp);
      break;
    }

    case 'sit': {
      var sr = mgr.get(conn.roomCode);
      if (!sr || sr.started) return;
      if (sr.moveSeat(conn.fp, msg.seat)) {
        conn.seat = msg.seat;
        conn.send({ t: 'room', state: sr.roomState(conn.seat) });
        broadcast(sr, { t: 'room', state: sr.roomState(-1) }, conn);
      }
      break;
    }

    case 'addbot': {
      var abr = mgr.get(conn.roomCode);
      if (!abr || abr.started) return;
      if (conn.seat !== abr.hostSeat) { conn.send({ t: 'error', msg: '只有房主可以添加机器人' }); return; }
      var bs = abr.addBot();
      if (bs < 0) { conn.send({ t: 'error', msg: '没有空座位了' }); return; }
      conn.send({ t: 'room', state: abr.roomState(conn.seat) });
      broadcast(abr, { t: 'room', state: abr.roomState(-1) }, conn);
      console.log('[addbot] %s seat=%d', abr.code, bs);
      break;
    }

    case 'start': {
      var kr = mgr.get(conn.roomCode);
      if (!kr) return;
      if (conn.seat !== kr.hostSeat) { conn.send({ t: 'error', msg: '只有房主可以开始' }); return; }
      var order = kr.start();                 // 内部按需在空位补机器人
      if (order) {
        conn.send({ t: 'room', state: kr.roomState(conn.seat) });
        broadcast(kr, { t: 'room', state: kr.roomState(-1) }, conn);
        broadcast(kr, { t: 'start', order: order, you: conn.seat });
        broadcast(kr, { t: 'snapshot', state: kr.snapshot() });
        var nb = kr.seats.filter(function (s) { return s && s.bot; }).length;
        console.log('[start] %s order=%j bots=%d', kr.code, order, nb);
      }
      break;
    }

    case 'clear': {
      var cr = mgr.get(conn.roomCode);
      if (!cr || !cr.started) return;
      var res = cr.applyClear(conn.fp, msg.lines);
      if (res && res.to >= 0) deliverAttack(cr, res.from, res.to, res.lines);
      break;
    }

    case 'dead': {
      var dr = mgr.get(conn.roomCode);
      if (!dr || !dr.started) return;
      var dead = dr.markDead(conn.fp);
      var seat = dr.findSeatOf(conn.fp);
      broadcast(dr, { t: 'dead', seat: seat, by: dr.seats[seat] ? dr.seats[seat].lastAttacker : null });
      if (dead.over) broadcast(dr, { t: 'over', winner: dead.winner, ranking: dr.buildRanking(dead.winner) });
      break;
    }

    case 'sync': {
      var sr2 = mgr.get(conn.roomCode);
      if (!sr2) return;
      sr2.updateBoard(conn.fp, msg.board, msg.score, msg.lines, msg.piece);
      markDirty(sr2);
      break;
    }

    case 'ping':
      conn.send({ t: 'pong', t: msg.t });
      break;

    /* 联机暂停：每位玩家本局仅一次机会；发起后所有玩家方块冻结并显示蒙版 + 30s 倒计时。
     * 由服务器权威计时，倒计时结束广播 resume 解除冻结。同一时刻只允许一个暂停进行。 */
    case 'pause': {
      var pr = mgr.get(conn.roomCode);
      if (!pr || !pr.started) return;
      var seat = pr.findSeatOf(conn.fp);
      if (seat < 0) return;
      if (!pr.seats[seat].alive) { conn.send({ t: 'error', msg: '你已出局，无法暂停' }); return; }
      if (pr.pauseUsed[seat]) { conn.send({ t: 'error', msg: '本局你已使用过暂停' }); return; }
      if (pr.pause && pr.pause.active) { conn.send({ t: 'error', msg: '当前已有玩家暂停中' }); return; }
      pr.pauseUsed[seat] = true;
      var until = Date.now() + PR_PAUSE_MS;
      pr.pause = { active: true, by: seat, until: until };
      var ps = pr.seats[seat];
      broadcast(pr, { t: 'paused', by: seat, name: ps.name, avatar: ps.avatar, until: until, dur: PR_PAUSE_MS });
      pr._pauseTimer = setTimeout(function () {
        pr.pause = null;
        pr._pauseTimer = null;
        broadcast(pr, { t: 'resume' });
      }, PR_PAUSE_MS);
      console.log('[pause] %s seat=%d until=%d', pr.code, seat, until);
      break;
    }

    case 'leave':
      leave(conn);
      break;
  }
}

/* ---------- 快照节流推送（120ms） ---------- */
setInterval(function () {
  if (!dirtyRooms.size) return;
  dirtyRooms.forEach(function (code) {
    var room = mgr.get(code);
    if (!room) { dirtyRooms.delete(code); return; }
    broadcast(room, { t: 'snapshot', state: room.snapshot() });
    dirtyRooms.delete(code);
  });
}, 120);

/* ---------- 机器人真实对局驱动 ----------
 * 每个机器人用 BotEngine 真实地下落/堆叠/消行；消行即攻击环形下一个存活座位（真实攻击环），
 * 被攻击则固化块真实从底部上升。引擎权威，客户端只做缩略图渲染。
 * 每 100ms 推进 2 帧（≈50ms/步），使机器人节奏明快、首消约 7s 内出现，且棋子明显在动。 */
/* 机器人节奏：每 BOT_TICK_MS 毫秒推进 BOT_STEPS_PER_TICK 帧（每帧下落/平移一格）。
 * 之前 100ms×2 帧≈50ms/步，节奏过快人类跟不上；现默认 200ms×1 帧≈200ms/步（约 5 格/秒），
 * 与人类休闲手速相当。可用环境变量 BOT_TICK_MS / BOT_STEPS_PER_TICK 微调。 */
var BOT_TICK_MS = parseInt(process.env.BOT_TICK_MS, 10);
if (!(BOT_TICK_MS >= 50)) BOT_TICK_MS = 200;
var BOT_STEPS_PER_TICK = parseInt(process.env.BOT_STEPS_PER_TICK, 10);
if (!(BOT_STEPS_PER_TICK >= 1)) BOT_STEPS_PER_TICK = 1;
setInterval(function () {
    for (var code in mgr.rooms) {
    var room = mgr.rooms[code];
    if (!room || !room.started) continue;
    if (room.pause && room.pause.active) continue;   // 暂停期间冻结所有机器人推进
    var dirty = false;
    for (var i = 0; i < room.seats.length; i++) {
      var s = room.seats[i];
      if (!s || !s.bot || !s.alive || !s.engine) continue;
      for (var k = 0; k < BOT_STEPS_PER_TICK; k++) {
        var res = s.engine.step();          // 真实推进一帧
        s.board = s.engine.pack();
        s.piece = s.engine.pieceNet();
        s.score = s.engine.score;
        s.lines = s.engine.lines;
        s.cured = s.engine.board.cured;
        if (res.dead) {
          s.alive = false;
          room._recordDeath(i);
          broadcast(room, { t: 'dead', seat: i, by: s.lastAttacker });
          var dw = room.checkWin();
          if (dw.over) broadcast(room, { t: 'over', winner: dw.winner, ranking: room.buildRanking(dw.winner) });
          dirty = true;
          break;
        } else if (res.lines > 0) {
          var to = room.nextSeat(i);          // 真实环形攻击：下一个存活座位
          if (to >= 0) deliverAttack(room, i, to, res.lines);
          dirty = true;
          if (!room.started) break;            // deliverAttack 内已判定终局并广播 over → 停止本周期
        } else {
          dirty = true;                        // 持续刷新方块下落动画
        }
      }
    }
    if (dirty) markDirty(room);
  }
}, BOT_TICK_MS);

/* ---------- HTTP 静态托管 ---------- */
var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveFile(res, filePath) {
  fs.readFile(filePath, function (err, data) {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    var ext = path.extname(filePath).toLowerCase();
    // 关键：脚本/样式禁用缓存，避免浏览器长期使用旧的 battle.js 导致「点击切换观战无效」等怪异行为
    var headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.js' || ext === '.css' || ext === '.html') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    res.writeHead(200, headers);
    res.end(data);
  });
}

var httpServer = http.createServer(function (req, res) {
  var u = req.url.split('?')[0];
  if (u === '/' || u === '/index.html') return serveFile(res, path.join(ROOT, 'index.html'));
  if (u === '/battle' || u === '/battle.html') return serveFile(res, path.join(ROOT, 'battle.html'));
  // 安全：限制在 ROOT 内，阻止目录穿越
  var target = path.normalize(path.join(ROOT, u));
  if (target.indexOf(ROOT) !== 0) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(res, target);
});

/* ---------- WebSocket 接入（须在 httpServer 创建之后） ---------- */
ws.createWebSocketServer(httpServer, {
  onConnect: function (conn) {
    conn.fp = null;
    conn.roomCode = null;
    conn.seat = -1;
    conn.meta = { name: '玩家', avatar: '🦊' };
    clients.add(conn);
    conn.onMessage = function (msg) { handle(conn, msg); };
    conn.onClose = function () { clients.delete(conn); leave(conn); };
  }
});

httpServer.listen(PORT, function () {
  console.log('魔方坠落 · 联机对战服务器已启动');
  console.log('  单人对战:  http://localhost:' + PORT + '/');
  console.log('  联机对战:  http://localhost:' + PORT + '/battle');
  console.log('  WebSocket: ws://localhost:' + PORT + '/');
});
