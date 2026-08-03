/* core.js - 棋盘、方块、SRS 旋转与落点寻路
 * 纯逻辑层，不依赖任何 DOM / Canvas，可直接移植到小程序。
 * 坐标系：x 向右为正，y 向下为正（屏幕坐标）。
 */
(function (global) {
  'use strict';

  var TZ = global.TZ || (global.TZ = {});

  /* ---------- 配置 ---------- */
  var CFG = {
    COLS: 10,
    ROWS: 20,
    BUFFER: 2,          // 顶部隐藏缓冲行，方块在此生成
    LOCK_DELAY: 500,    // 触底锁定延迟 ms
    MAX_LOCK_RESET: 15, // 锁定延迟最多被重置次数，防止无限拖延
    DROP_BASE: 1000     // 一级下落间隔 ms
  };

  /* ---------- 形状：四个旋转态的格子坐标 ---------- */
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

  /* ---------- SRS 踢墙表（已转换为 y 向下的屏幕坐标） ---------- */
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

  /* ---------- 7-bag 随机器 ---------- */
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
  Bag.prototype.peek = function (n) {
    while (this.queue.length < n + 1) this.refill();
    return this.queue.slice(0, n);
  };

  /* ---------- 方块 ---------- */
  function Piece(type) {
    this.type = type;
    this.rot = 0;
    this.color = COLORS[type];
    // 生成位置：水平居中偏左，位于缓冲区
    this.x = type === 'O' ? 4 : 3;
    this.y = 0;
  }
  Piece.prototype.cells = function (rot, ox, oy) {
    var r = rot == null ? this.rot : rot;
    var bx = ox == null ? this.x : ox;
    var by = oy == null ? this.y : oy;
    var src = SHAPES[this.type][r];
    var out = [];
    for (var i = 0; i < src.length; i++) {
      out.push([src[i][0] + bx, src[i][1] + by]);
    }
    return out;
  };
  Piece.prototype.clone = function () {
    var p = new Piece(this.type);
    p.rot = this.rot; p.x = this.x; p.y = this.y;
    return p;
  };

  /* ---------- 棋盘 ---------- */
  function Board(cols, rows, buffer) {
    this.cols = cols || CFG.COLS;
    this.rows = rows || CFG.ROWS;
    this.buffer = buffer == null ? CFG.BUFFER : buffer;
    this.total = this.rows + this.buffer;
    this.grid = [];
    for (var y = 0; y < this.total; y++) {
      var row = [];
      for (var x = 0; x < this.cols; x++) row.push(null);
      this.grid.push(row);
    }
  }

  Board.prototype.at = function (x, y) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.total) return undefined;
    return this.grid[y][x];
  };

  /* 碰撞检测：越界或撞到已固化格子返回 true */
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

  /* 尝试旋转，成功返回 {rot,x,y,kick}，失败返回 null */
  Board.prototype.tryRotate = function (piece, dir) {
    var from = piece.rot;
    var to = (from + (dir > 0 ? 1 : 3)) % 4;
    var list = kicksFor(piece.type, from, to);
    for (var i = 0; i < list.length; i++) {
      var nx = piece.x + list[i][0];
      var ny = piece.y + list[i][1];
      if (!this.collides(piece, to, nx, ny)) {
        return { rot: to, x: nx, y: ny, kickIndex: i };
      }
    }
    return null;
  };

  /* 计算硬降落点的 y。
   * 若起始位置本身就与堆叠重叠（例如把已下落较深的方块预览到更高的列），
   * 先向上抬到合法位置再下探，否则会算出一个埋在堆里的假落点。 */
  Board.prototype.dropY = function (piece, rot, ox, startY) {
    var r = rot == null ? piece.rot : rot;
    var x = ox == null ? piece.x : ox;
    var y = startY == null ? piece.y : startY;
    var guard = 0;
    while (this.collides(piece, r, x, y) && y > -6 && guard++ < 40) y--;
    while (!this.collides(piece, r, x, y + 1)) y++;
    return y;
  };

  /* 固化方块，返回占用的格子 */
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

  /* 找出所有满行 */
  Board.prototype.fullRows = function () {
    var rows = [];
    for (var y = 0; y < this.total; y++) {
      var full = true;
      for (var x = 0; x < this.cols; x++) {
        if (!this.grid[y][x]) { full = false; break; }
      }
      if (full) rows.push(y);
    }
    return rows;
  };

  /* 清除指定行并下移 */
  Board.prototype.clearRows = function (rows) {
    if (!rows.length) return;
    var set = {};
    for (var i = 0; i < rows.length; i++) set[rows[i]] = true;
    var next = [];
    for (var y = 0; y < this.total; y++) {
      if (!set[y]) next.push(this.grid[y]);
    }
    while (next.length < this.total) {
      var row = [];
      for (var x = 0; x < this.cols; x++) row.push(null);
      next.unshift(row);
    }
    this.grid = next;
  };

  /* 顶部溢出判定 */
  Board.prototype.isTopOut = function (piece) {
    return this.collides(piece, piece.rot, piece.x, piece.y);
  };

  /* ---------- 落点导航：BFS 寻路 ----------
   * 在 (x, y, rot) 状态空间搜索，算子为 左移/右移/下落/顺时针/逆时针。
   * 目标是让方块最终"落在"指定列附近，且该状态必须是一个合法的着陆位。
   * 返回 { path, x, y, rot, exact }，找不到则返回 null。
   * 返回真实终点而不只是操作序列，让导航预览与实际执行结果完全一致。
   */
  Board.prototype.findPath = function (piece, targetX, targetRot) {
    var self = this;
    var wantRot = targetRot == null ? piece.rot : targetRot;

    function key(x, y, r) { return x + ',' + y + ',' + r; }

    // 判断某状态是否为着陆状态（下方无法再移动）
    function landed(x, y, r) {
      return self.collides(piece, r, x, y + 1);
    }

    var start = { x: piece.x, y: piece.y, rot: piece.rot };
    if (this.collides(piece, start.rot, start.x, start.y)) return null;

    var visited = {};
    visited[key(start.x, start.y, start.rot)] = true;
    var queue = [{ x: start.x, y: start.y, rot: start.rot, path: [] }];
    var best = null;
    var bestScore = Infinity;
    var guard = 0;

    while (queue.length && guard++ < 6000) {
      var cur = queue.shift();

      if (landed(cur.x, cur.y, cur.rot)) {
        // 以「左上角列差」和「旋转态是否匹配」打分，越小越好
        var dx = Math.abs(cur.x - targetX);
        var dr = cur.rot === wantRot ? 0 : 1;
        var score = dx * 10 + dr * 3 + cur.path.length * 0.05;
        if (score < bestScore) { bestScore = score; best = cur; }
        if (dx === 0 && dr === 0) break; // 完美命中，提前结束
      }

      var moves = [
        { op: 'L', x: cur.x - 1, y: cur.y, rot: cur.rot },
        { op: 'R', x: cur.x + 1, y: cur.y, rot: cur.rot },
        { op: 'D', x: cur.x, y: cur.y + 1, rot: cur.rot }
      ];

      // 旋转算子需要走踢墙表
      var tmp = piece.clone();
      tmp.x = cur.x; tmp.y = cur.y; tmp.rot = cur.rot;
      var cw = this.tryRotate(tmp, 1);
      if (cw) moves.push({ op: 'CW', x: cw.x, y: cw.y, rot: cw.rot });
      var ccw = this.tryRotate(tmp, -1);
      if (ccw) moves.push({ op: 'CCW', x: ccw.x, y: ccw.y, rot: ccw.rot });

      for (var i = 0; i < moves.length; i++) {
        var m = moves[i];
        if (this.collides(piece, m.rot, m.x, m.y)) continue;
        var k = key(m.x, m.y, m.rot);
        if (visited[k]) continue;
        visited[k] = true;
        queue.push({ x: m.x, y: m.y, rot: m.rot, path: cur.path.concat([m.op]) });
      }
    }

    if (!best) return null;
    return {
      path: best.path.concat(['DROP']),
      x: best.x,
      y: best.y,
      rot: best.rot,
      exact: best.x === targetX && best.rot === wantRot
    };
  };

  /* ---------- 计分 ---------- */
  var LINE_SCORE = [0, 100, 300, 500, 800];
  function scoreFor(lines, level, isTSpin) {
    var base = LINE_SCORE[lines] || 0;
    if (isTSpin) base += lines * 400 + 400;
    return base * (level + 1);
  }

  TZ.CFG = CFG;
  TZ.SHAPES = SHAPES;
  TZ.COLORS = COLORS;
  TZ.TYPES = TYPES;
  TZ.Bag = Bag;
  TZ.Piece = Piece;
  TZ.Board = Board;
  TZ.scoreFor = scoreFor;

})(typeof window !== 'undefined' ? window : this);
