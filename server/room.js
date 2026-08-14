/*!
 * ============================================================================
 *  魔方坠落 · 联机对战 — 房间与对战逻辑（服务器权威：存活 / 胜负 / 攻击环）
 * ----------------------------------------------------------------------------
 *  @file         server/room.js
 *  @description  房间生命周期、环形攻击结算、存活与胜负裁决、棋盘中转
 *  @author       wangzhuo <mail_zhuo@163.com>
 * ============================================================================
 */
'use strict';

var BotEngine = require('./botengine.js').BotEngine;

function genCode() {
  var n = Math.floor(1000 + Math.random() * 9000);
  return 'XZ-' + n;
}

/* ---------- 房间 ---------- */
function Room(code, count) {
  this.code = code;
  this.count = count;
  this.seats = new Array(count).fill(null); // 每位: {fp,name,avatar,alive,board,score,lines,bot?,engine?}
  this.started = false;
  this.hostSeat = 0;
  this.botSeq = 0;                          // 机器人命名序号
  this.deathOrder = [];                     // 淘汰顺序（座位号，先出局者在前）
  this.pauseUsed = [];                      // 每位是否已使用过暂停（一次机会）
  this.pause = null;                        // 当前暂停态 {active, by, until}，无则 null
  this._pauseTimer = null;                  // 暂停倒计时定时器
}

Room.prototype.findSeatOf = function (fp) {
  for (var i = 0; i < this.seats.length; i++) {
    if (this.seats[i] && this.seats[i].fp === fp) return i;
  }
  return -1;
};

Room.prototype.firstEmpty = function () {
  for (var i = 0; i < this.seats.length; i++) if (!this.seats[i]) return i;
  return -1;
};

Room.prototype.addPlayer = function (fp, name, avatar) {
  var s = this.findSeatOf(fp);
  if (s < 0) s = this.firstEmpty();
  if (s < 0) return -1;
  this.seats[s] = { fp: fp, name: name || '玩家', avatar: avatar || '🦊', alive: true, board: null, score: 0, lines: 0, lastAttacker: null };
  return s;
};

/* 加入一个机器人到首个空座位；返回座位号，无空位返回 -1。
 * 机器人携带一个真实的无头游戏引擎（BotEngine），从空盘开始真实对局。 */
Room.prototype.addBot = function () {
  var s = this.firstEmpty();
  if (s < 0) return -1;
  this.botSeq++;
  var eng = new BotEngine();
  this.seats[s] = {
    fp: 'bot_' + this.code + '_' + this.botSeq,
    name: '机器人 ' + this.botSeq,
    avatar: '🤖',
    alive: true,
    bot: true,
    engine: eng,
    board: eng.pack(),
    piece: eng.pieceNet(),
    score: 0,
    lines: 0,
    cured: 0,
    lastAttacker: null
  };
  return s;
};

/* 用机器人填满所有空座位；返回新加入的座位号数组 */
Room.prototype.fillBots = function () {
  var added = [];
  for (;;) {
    var s = this.addBot();
    if (s < 0) break;
    added.push(s);
  }
  return added;
};

Room.prototype.moveSeat = function (fp, seat) {
  if (seat < 0 || seat >= this.seats.length) return false;
  if (this.seats[seat]) return false;            // 目标已占
  var cur = this.findSeatOf(fp);
  if (cur < 0) return false;
  var p = this.seats[cur];
  this.seats[cur] = null;
  this.seats[seat] = p;
  return true;
};

/* 返回 {seat, started, removed}  removed=true 表示是开战后离场（判负） */
Room.prototype.removePlayer = function (fp) {
  var s = this.findSeatOf(fp);
  if (s < 0) return { seat: -1, started: this.started, removed: false };
  var started = this.started;
  if (started) {
    this.seats[s].alive = false;                 // 开战中途离开 = 判负
    this._recordDeath(s);
    return { seat: s, started: true, removed: true };
  }
  this.seats[s] = null;
  return { seat: s, started: false, removed: false };
};

Room.prototype.isFull = function () {
  for (var i = 0; i < this.seats.length; i++) if (!this.seats[i]) return false;
  return true;
};

Room.prototype.start = function () {
  if (this.started) return false;
  if (!this.isFull()) this.fillBots();   // 人数不足：机器人自动补位，保证可开局
  // 重开一局：复位上一局残态（结算页「返回房间」再开时，死掉的座位要复活）
  this.deathOrder = [];
  for (var i = 0; i < this.seats.length; i++) {
    var s = this.seats[i];
    if (!s) continue;
    s.alive = true;
    s.lastAttacker = null;
    if (s.bot && s.engine) {                 // 机器人引擎整局重置（清空棋盘/分数/固化）
      s.engine = new BotEngine();
      s.board = s.engine.pack();
      s.piece = s.engine.pieceNet();
      s.score = 0; s.lines = 0; s.cured = 0;
    }
  }
  // 重置本局暂停状态（每位一次机会）
  this.pauseUsed = new Array(this.seats.length).fill(false);
  this.pause = null;
  if (this._pauseTimer) { clearTimeout(this._pauseTimer); this._pauseTimer = null; }
  this.started = true;
  var order = [];
  for (var i = 0; i < this.seats.length; i++) order.push(i);
  return order;
};

/* 环形攻击：返回 from 的下一个「存活」座位（含已开战的座位环） */
Room.prototype.nextSeat = function (from) {
  var alive = [];
  for (var i = 0; i < this.seats.length; i++) {
    if (this.seats[i] && this.seats[i].alive) alive.push(i);
  }
  if (alive.length <= 1) return -1;
  var idx = alive.indexOf(from);
  if (idx < 0) return alive[0];
  return alive[(idx + 1) % alive.length];
};

/* 结算一次消行攻击：from 消了 lines 行 → 攻击 nextSeat；返回 {from,to,lines} */
Room.prototype.applyClear = function (fp, lines) {
  var from = this.findSeatOf(fp);
  if (from < 0) return null;
  var to = this.nextSeat(from);
  return { from: from, to: to, lines: lines };
};

Room.prototype.markDead = function (fp) {
  var s = this.findSeatOf(fp);
  if (s < 0) return { over: false, winner: -1 };
  this.seats[s].alive = false;
  this._recordDeath(s);
  return this.checkWin();
};

Room.prototype.checkWin = function () {
  var alive = [];
  for (var i = 0; i < this.seats.length; i++) {
    if (this.seats[i] && this.seats[i].alive) alive.push(i);
  }
  if (alive.length <= 1) {
    this.started = false;            // 终局：停掉机器人循环与快照广播，避免「已结算却仍在跑」
    if (this._pauseTimer) { clearTimeout(this._pauseTimer); this._pauseTimer = null; }
    this.pause = null;               // 终局清空暂停态，避免遗留倒计时误触发 resume
    return { over: true, winner: alive.length === 1 ? alive[0] : -1 };
  }
  return { over: false, winner: -1 };
};

/* 记录一次淘汰（去重），用于最终战绩排行 */
Room.prototype._recordDeath = function (seat) {
  if (this.deathOrder.indexOf(seat) < 0) this.deathOrder.push(seat);
};

/* 构建最终战绩排行：胜者第一，其余按出局先后倒序（越晚出局名次越高）。
 * 每位含 seat/name/avatar/bot/score/lines/alive/place，供客户端结算界面渲染。 */
Room.prototype.buildRanking = function (winner) {
  var players = [];
  for (var i = 0; i < this.seats.length; i++) {
    var s = this.seats[i];
    if (!s) continue;
    players.push({
      seat: i,
      name: s.name,
      avatar: s.avatar,
      bot: !!s.bot,
      score: (s.bot && s.engine) ? s.engine.score : (s.score || 0),
      lines: (s.bot && s.engine) ? s.engine.lines : (s.lines || 0),
      alive: !!s.alive
    });
  }
  // 排名顺序：胜者 → 出局顺序倒序 → 兜底（遗漏座位）
  var order = [];
  if (winner >= 0) order.push(winner);
  for (var k = this.deathOrder.length - 1; k >= 0; k--) order.push(this.deathOrder[k]);
  for (var j = 0; j < players.length; j++) {
    if (order.indexOf(players[j].seat) < 0) order.push(players[j].seat);
  }
  var ranked = [];
  for (var p = 0; p < order.length; p++) {
    var seat = order[p], found = null;
    for (var q = 0; q < players.length; q++) if (players[q].seat === seat) { found = players[q]; break; }
    if (!found) continue;
    found.place = p + 1;
    ranked.push(found);
  }
  return ranked;
};

/* 人类玩家：接收其客户端同步的棋盘/活动方块（机器人数据来自引擎，不走这里） */
Room.prototype.updateBoard = function (fp, board, score, lines, piece) {
  var s = this.findSeatOf(fp);
  if (s < 0) return;
  this.seats[s].board = board;
  this.seats[s].score = score || 0;
  this.seats[s].lines = lines || 0;
  this.seats[s].piece = piece || null;
};

/* 给客户端的房间状态（不含棋盘，用于座位界面） */
Room.prototype.roomState = function (youSeat) {
  var seats = this.seats.map(function (s, i) {
    return s ? { seat: i, fp: s.fp, name: s.name, avatar: s.avatar, alive: s.alive, bot: !!s.bot } : null;
  });
  return { code: this.code, count: this.count, seats: seats, you: youSeat, host: this.hostSeat, started: this.started };
};

/* 给客户端的对战快照（含棋盘 + 活动方块，用于缩略图与 HUD）。
 * 机器人：数据直接从真实引擎取出（board/piece/score/lines）。 */
Room.prototype.snapshot = function () {
  var players = this.seats.map(function (s, i) {
    if (!s) return null;
    var board = (s.bot && s.engine) ? s.engine.pack() : (s.board || '');
    var piece = (s.bot && s.engine) ? s.engine.pieceNet() : (s.piece || null);
    var score = (s.bot && s.engine) ? s.engine.score : (s.score || 0);
    var lines = (s.bot && s.engine) ? s.engine.lines : (s.lines || 0);
    return { seat: i, fp: s.fp, name: s.name, avatar: s.avatar, alive: s.alive, bot: !!s.bot, board: board, piece: piece, score: score, lines: lines };
  });
  return { players: players };
};

/* ---------- 房间管理器 ---------- */
function RoomManager() {
  this.rooms = {};
}

RoomManager.prototype.genCode = function () {
  var code, guard = 0;
  do { code = genCode(); guard++; } while (this.rooms[code] && guard < 50);
  return code;
};

RoomManager.prototype.create = function (count) {
  count = Math.max(2, Math.min(9, count | 0));
  var code = this.genCode();
  var room = new Room(code, count);
  this.rooms[code] = room;
  return room;
};

RoomManager.prototype.get = function (code) {
  return this.rooms[code] || null;
};

RoomManager.prototype.drop = function (code) {
  delete this.rooms[code];
};

module.exports = { RoomManager: RoomManager, Room: Room, genCode: genCode, BotEngine: BotEngine };
