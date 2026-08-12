/*!
 * ============================================================================
 *  魔方坠落 · 联机对战 — 机器人无头游戏引擎（服务器权威真实对局）
 * ----------------------------------------------------------------------------
 *  @file        server/botengine.js
 *  @description 复刻 core.js 的纯力学，让机器人在服务端真正地玩：
 *               7-bag 出块、SRS 旋转、重力下落、碰撞、锁定、消行、
 *               被攻击固化上升(addCured) / 自愈(digCured) / 顶出判负。
 *               棋盘序列化格式与客户端 TZ.packBoard 完全一致，
 *               活动方块坐标与客户端同源（绝对坐标，含顶部缓冲行）。
 *  @author      wangzhuo <mail_zhuo@163.com>
 * ============================================================================
 */
'use strict';

/* ---------- 配置（与 core.js 保持一致） ---------- */
var CFG = { COLS: 10, ROWS: 20, BUFFER: 2, LOCK_DELAY: 500, MAX_LOCK_RESET: 15, DROP_BASE: 1000 };

/* ---------- 形状：四个旋转态的格子坐标（与 core.js 逐字一致） ---------- */
var SHAPES = {
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[1, 0], [1, 1], [1, 2], [1, 3]]
  ],
  J: [
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [0, 2], [1, 2]]
  ],
  L: [
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[0, 0], [1, 0], [1, 1], [1, 2]]
  ],
  O: [
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[0, 0], [1, 0], [0, 1], [1, 1]]
  ],
  S: [
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
    [[1, 1], [2, 1], [0, 2], [1, 2]],
    [[0, 0], [0, 1], [1, 1], [1, 2]]
  ],
  T: [
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [1, 2]]
  ],
  Z: [
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[1, 0], [0, 1], [1, 1], [0, 2]]
  ]
};

var COLORS = {
  I: '#38d6cc', J: '#4a7bd8', L: '#f2932b', O: '#f5cf3d',
  S: '#5fba46', T: '#a95ee8', Z: '#e8494c'
};

var TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

/* ---------- SRS 踢墙表（已转换为 y 向下的屏幕坐标，与 core.js 一致） ---------- */
var KICK_JLSTZ = {
  '0>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '1>0': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '1>2': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '2>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '2>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '3>2': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '3>0': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '0>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]
};
var KICK_I = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]]
};
function kicksFor(type, from, to) {
  if (type === 'O') return [[0, 0]];
  var table = type === 'I' ? KICK_I : KICK_JLSTZ;
  return table[from + '>' + to] || [[0, 0]];
}

/* ---------- 7-bag 随机器（与 core.js 一致） ---------- */
function Bag() {
  this.queue = [];
  this.refill();
  this.refill();
}
Bag.prototype.refill = function () {
  var pool = TYPES.slice();
  for (var i = pool.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  this.queue = this.queue.concat(pool);
};
Bag.prototype.next = function () {
  if (this.queue.length <= 7) this.refill();
  return this.queue.shift();
};

/* ---------- 方块（与 core.js 一致） ---------- */
function Piece(type) {
  this.type = type;
  this.rot = 0;
  this.color = COLORS[type];
  this.x = type === 'O' ? 4 : 3;
  this.y = 0;            // 绝对行，0 = 缓冲行顶部
}
Piece.prototype.cells = function (rot, ox, oy) {
  var r = rot == null ? this.rot : rot;
  var bx = ox == null ? this.x : ox;
  var by = oy == null ? this.y : oy;
  var src = SHAPES[this.type][r];
  var out = [];
  for (var i = 0; i < src.length; i++) out.push([src[i][0] + bx, src[i][1] + by]);
  return out;
};
Piece.prototype.clone = function () {
  var p = new Piece(this.type);
  p.rot = this.rot; p.x = this.x; p.y = this.y;
  return p;
};

/* ---------- 棋盘（与 core.js 一致，小幅命名调整） ---------- */
function Board(cols, rows, buffer) {
  this.cols = cols || CFG.COLS;
  this.rows = rows || CFG.ROWS;
  this.buffer = buffer == null ? CFG.BUFFER : buffer;
  this.total = this.rows + this.buffer;
  this.cured = 0;        // 固化块行数（从底部向上累计）
  this.grid = [];
  for (var y = 0; y < this.total; y++) {
    var row = [];
    for (var x = 0; x < this.cols; x++) row.push(null);
    this.grid.push(row);
  }
}

Board.prototype.addCured = function (n) {
  if (n <= 0) return false;
  var overflow = false;
  for (var k = 0; k < n; k++) {
    var topRow = this.grid[0];
    for (var x = 0; x < this.cols; x++) { if (topRow[x]) { overflow = true; break; } }
    this.grid.shift();
    var row = [];
    for (var c = 0; c < this.cols; c++) row.push({ type: 'X', color: '#3a2a2a', cured: true });
    this.grid.push(row);
    this.cured++;
  }
  return overflow;
};

Board.prototype.digCured = function () {
  if (this.cured <= 0) return;
  this.grid.pop();
  this.cured--;
  var row = [];
  for (var x = 0; x < this.cols; x++) row.push(null);
  this.grid.unshift(row);
};

Board.prototype.at = function (x, y) {
  if (x < 0 || x >= this.cols || y < 0 || y >= this.total) return undefined;
  return this.grid[y][x];
};

Board.prototype.collides = function (piece, rot, ox, oy) {
  var cells = piece.cells(rot, ox, oy);
  for (var i = 0; i < cells.length; i++) {
    var x = cells[i][0], y = cells[i][1];
    if (x < 0 || x >= this.cols) return true;
    if (y >= this.total) return true;
    if (y >= 0 && this.grid[y][x]) return true;
  }
  return false;
};

Board.prototype.tryRotate = function (piece, dir) {
  var from = piece.rot;
  var to = (from + (dir > 0 ? 1 : 3)) % 4;
  var list = kicksFor(piece.type, from, to);
  for (var i = 0; i < list.length; i++) {
    var nx = piece.x + list[i][0];
    var ny = piece.y + list[i][1];
    if (!this.collides(piece, to, nx, ny)) return { rot: to, x: nx, y: ny, kickIndex: i };
  }
  return null;
};

Board.prototype.dropY = function (piece, rot, ox, startY) {
  var r = rot == null ? piece.rot : rot;
  var x = ox == null ? piece.x : ox;
  var y = startY == null ? piece.y : startY;
  var guard = 0;
  while (this.collides(piece, r, x, y) && y > -6 && guard++ < 40) y--;
  while (!this.collides(piece, r, x, y + 1)) y++;
  return y;
};

Board.prototype.lock = function (piece) {
  var cells = piece.cells();
  var placed = [];
  for (var i = 0; i < cells.length; i++) {
    var x = cells[i][0], y = cells[i][1];
    if (y >= 0 && y < this.total && x >= 0 && x < this.cols) {
      this.grid[y][x] = { type: piece.type, color: piece.color };
      placed.push([x, y]);
    }
  }
  return placed;
};

Board.prototype.fullRows = function () {
  var rows = [];
  var top = this.total - this.cured;   // 可消除区上界（不含固化带）
  for (var y = 0; y < top; y++) {
    var full = true;
    for (var x = 0; x < this.cols; x++) { if (!this.grid[y][x]) { full = false; break; } }
    if (full) rows.push(y);
  }
  return rows;
};

Board.prototype.clearRows = function (rows) {
  if (!rows.length) return;
  var set = {};
  for (var i = 0; i < rows.length; i++) set[rows[i]] = true;
  var next = [];
  for (var y = 0; y < this.total; y++) { if (!set[y]) next.push(this.grid[y]); }
  while (next.length < this.total) {
    var row = [];
    for (var x = 0; x < this.cols; x++) row.push(null);
    next.unshift(row);
  }
  this.grid = next;
};

Board.prototype.isTopOut = function (piece) {
  return this.collides(piece, piece.rot, piece.x, piece.y);
};

/* ---------- 计分 ---------- */
var LINE_SCORE = [0, 100, 300, 500, 800];
function scoreFor(lines, level) {
  var base = LINE_SCORE[lines] || 0;
  return base * (level + 1);
}

/* ============================================================================
 *  BotEngine — 真实对局驱动器
 * ========================================================================== */
function BotEngine() {
  this.board = new Board();
  this.bag = new Bag();
  this.piece = null;
  this.score = 0;
  this.lines = 0;
  this.dead = false;
  this.targetX = 4;
  this.targetRot = 0;
  this.spawn();
}

BotEngine.prototype.spawn = function () {
  var t = this.bag.next();
  var p = new Piece(t);
  if (this.board.isTopOut(p)) {        // 出生即重叠 → 顶出判负
    this.dead = true;
    this.piece = p;
    return;
  }
  this.piece = p;
  this.chooseTarget();
};

/* 评估所有旋转 × 所有落列，挑选最优落点（消行优先，其次少空洞/低高度/平稳） */
BotEngine.prototype.chooseTarget = function () {
  var p = this.piece;
  if (!p) return;
  var rots = p.type === 'O' ? [0] : [0, 1, 2, 3];
  var best = null, bestScore = -Infinity;
  for (var ri = 0; ri < rots.length; ri++) {
    var r = rots[ri];
    for (var x = 0; x < this.board.cols; x++) {
      var ly = this.board.dropY(p, r, x, -2);
      if (ly === null) continue;
      if (this.board.collides(p, r, x, ly)) continue;   // 落点非法
      var sc = this.evalPlacement(p.type, r, x, ly);
      if (sc > bestScore) { bestScore = sc; best = { x: x, r: r }; }
    }
  }
  if (!best) best = { x: p.x, r: p.rot };
  this.targetX = best.x;
  this.targetRot = best.r;
};

/* 在网格副本上模拟「放置+消行」，返回该落点的启发式评分（越大越好）。
 * 采用经过严格验证的 El-Tetris 特征集（权重来自 El-Tetris 论文）：
 *   +3.4·消行 − 4.5·落点高度 − 3.2·行变换 − 9.3·列变换 − 7.9·空洞 − 3.4·井
 * 其中列变换权重极高，会强烈惩罚「空列紧挨实列」的碎片化布局，
 * 迫使机器人去填满空列 —— 从而真正地堆高、凑满整行、持续真实消行与攻击。 */
BotEngine.prototype.evalPlacement = function (type, r, x, y) {
  var COLS = this.board.cols, TOTAL = this.board.total;
  var g = this.board.grid.map(function (row) { return row.slice(); });
  var cells = SHAPES[type][r];
  var topY = TOTAL;
  for (var i = 0; i < cells.length; i++) {
    var cx = cells[i][0] + x, cy = cells[i][1] + y;
    if (cy >= 0 && cy < TOTAL && cx >= 0 && cx < COLS) g[cy][cx] = { type: type };
    if (cy < topY) topY = cy;
  }
  var landingHeight = TOTAL - topY;
  // 消除可消除区满行（固化带不参与消除）
  var cured = this.board.cured;
  var top = TOTAL - cured;
  var cleared = 0;
  var ng = [];
  for (var yy = 0; yy < TOTAL; yy++) {
    if (yy >= top) { ng.push(g[yy]); continue; }
    var full = true;
    for (var xx = 0; xx < COLS; xx++) { if (!g[yy][xx]) { full = false; break; } }
    if (full) cleared++; else ng.push(g[yy]);
  }
  while (ng.length < TOTAL) {
    var row = []; for (var xx2 = 0; xx2 < COLS; xx2++) row.push(null); ng.unshift(row);
  }
  // 行变换：左右边界视为已填充
  var rowT = 0;
  for (var y2 = 0; y2 < TOTAL; y2++) {
    var prev = 1;
    for (var x2 = 0; x2 < COLS; x2++) {
      var cur = ng[y2][x2] ? 1 : 0;
      if (cur !== prev) rowT++;
      prev = cur;
    }
    if (prev !== 1) rowT++;
  }
  // 列变换：顶/底边界视为已填充
  var colT = 0;
  for (var x3 = 0; x3 < COLS; x3++) {
    var prev2 = 1;
    for (var y3 = TOTAL - 1; y3 >= 0; y3--) {
      var cur2 = ng[y3][x3] ? 1 : 0;
      if (cur2 !== prev2) colT++;
      prev2 = cur2;
    }
    if (prev2 !== 1) colT++;
  }
  // 空洞：某列中「上方有方块、下方为空」的空格
  var holes = 0;
  for (var x4 = 0; x4 < COLS; x4++) {
    var seen = false;
    for (var y4 = 0; y4 < TOTAL; y4++) {
      if (ng[y4][x4]) seen = true;
      else if (seen) holes++;
    }
  }
  // 井：左右皆被填充的连续空格（上方从该列最高块起计数）
  var wells = 0;
  for (var x5 = 0; x5 < COLS; x5++) {
    for (var y5 = 0; y5 < TOTAL; y5++) {
      if (ng[y5][x5]) break;
      var left = (x5 === 0) ? 1 : (ng[y5][x5 - 1] ? 1 : 0);
      var right = (x5 === COLS - 1) ? 1 : (ng[y5][x5 + 1] ? 1 : 0);
      if (left && right) wells++;
    }
  }
  return 3.4 * cleared - 4.5 * landingHeight - 3.2 * rowT - 9.3 * colT - 7.9 * holes - 3.4 * wells;
};

/* 推进一帧：对齐旋转 → 对齐列 → 重力 → 落地锁定+消行+自愈。
 * 返回 { lines, dead }。lines>0 表示本帧消行了（应触发攻击下家）。 */
BotEngine.prototype.step = function () {
  if (this.dead || !this.piece) return { lines: 0, dead: this.dead };
  var p = this.piece;

  // 1) 对齐旋转
  if (p.rot !== this.targetRot) {
    var cw = this.board.tryRotate(p, 1);
    if (cw) { p.rot = cw.rot; p.x = cw.x; p.y = cw.y; }
    else {
      var ccw = this.board.tryRotate(p, -1);
      if (ccw) { p.rot = ccw.rot; p.x = ccw.x; p.y = ccw.y; }
    }
  }
  // 2) 对齐落列（仅在旋转已完成时）
  else if (p.x < this.targetX) {
    if (!this.board.collides(p, p.rot, p.x + 1, p.y)) p.x++;
  } else if (p.x > this.targetX) {
    if (!this.board.collides(p, p.rot, p.x - 1, p.y)) p.x--;
  }

  // 3) 重力
  if (!this.board.collides(p, p.rot, p.x, p.y + 1)) {
    p.y++;
    return { lines: 0, dead: false };
  }

  // 4) 落地：锁定 → 消行 → 自愈 → 出新块
  this.board.lock(p);
  var rows = this.board.fullRows();
  var cleared = 0;
  if (rows.length) {
    this.board.clearRows(rows);
    cleared = rows.length;
    this.lines += cleared;
    this.score += scoreFor(cleared, 0);
    if (this.board.cured > 0) this.board.digCured();   // 自愈：挖一层固化
  }
  this.spawn();
  return { lines: cleared, dead: this.dead };
};

/* 被攻击：固化块真实从底部上升。返回是否顶出判负。 */
BotEngine.prototype.addCured = function (n) {
  var overflow = this.board.addCured(n);
  // 网格整体上移后，活动方块可能重叠 → 向上抬到合法位置
  if (this.piece) {
    var guard = 0;
    while (this.board.collides(this.piece, this.piece.rot, this.piece.x, this.piece.y) && guard++ < 24) {
      this.piece.y--;
    }
  }
  return overflow;
};

/* 棋盘序列化（格式与客户端 TZ.packBoard 完全一致，附带固化带） */
BotEngine.prototype.pack = function () {
  var board = this.board;
  var rows = [];
  for (var y = board.buffer; y < board.total; y++) {
    var s = '';
    for (var x = 0; x < board.cols; x++) {
      var c = board.grid[y][x];
      if (!c) s += ' ';
      else if (c.cured) s += '#';
      else s += (TYPES.indexOf(c.type) + 1).toString();
    }
    rows.push(s);
  }
  return rows.join('/');
};

/* 活动方块（与人类客户端同源的绝对坐标，renderThumb 直接复用） */
BotEngine.prototype.pieceNet = function () {
  if (!this.piece) return null;
  return { t: this.piece.type, r: this.piece.rot, x: this.piece.x, y: this.piece.y };
};

module.exports = { BotEngine: BotEngine, Board: Board, SHAPES: SHAPES, TYPES: TYPES };
