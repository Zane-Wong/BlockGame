/*!
 * ============================================================================
 *  魔方坠落 · 手势俄罗斯方块  (Gesture Tetris)
 * ----------------------------------------------------------------------------
 *  @file         src/game.js
 *  @description  主循环、游戏状态机与响应式布局
 *  @author       wangzhuo <mail_zhuo@163.com>
 *  @contact      mail_zhuo@163.com
 *  @copyright    Copyright (c) 2026 wangzhuo. All rights reserved.
 *  @license      本项目为 wangzhuo 原创作品，受著作权法保护。
 *                未经作者书面许可，不得复制、修改、分发或用于任何商业用途。
 * ============================================================================
 *
 *  game.js - 主循环与游戏状态机
 */
(function (global) {
  'use strict';
  var TZ = global.TZ;

  var STATE = {
    READY: 'READY',
    PLAYING: 'PLAYING',
    NAVIGATING: 'NAVIGATING',
    LAUNCHING: 'LAUNCHING',
    CLEARING: 'CLEARING',
    PAUSED: 'PAUSED',
    OVER: 'OVER'
  };

  function Game(opts) {
    this.canvas = opts.canvas;
    this.ctx = this.canvas.getContext('2d');
    this.ui = opts.ui;
    this.dpr = 1;

    this.board = new TZ.Board();
    this.bag = new TZ.Bag();
    this.audio = new TZ.Audio();
    this.particles = new TZ.Particles();
    this.shake = new TZ.Shake();
    this.floaters = new TZ.Floaters();

    this.layout = { x: 0, y: 0, cell: 20, cols: this.board.cols, rows: this.board.rows };
    this.renderer = new TZ.Renderer(this.ctx, this.layout);

    this.state = STATE.READY;
    this.piece = null;
    this.score = 0;
    this.lines = 0;
    this.level = 0;
    this.combo = -1;
    this.best = parseInt(global.localStorage && localStorage.getItem('tz_best') || '0', 10) || 0;

    this.dropAcc = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.grounded = false;

    this.navTarget = null;
    this.navQueue = null;
    this.navStep = 0;
    this.launch = null;
    this.clearInfo = null;
    this.time = 0;

    this.setupGesture();
    this.resize();
    var self = this;
    // 用 ResizeObserver 跟踪舞台真实盒子：无论谁在什么时候改了外层宽度
    // （例如响应式 fit() 调整 #app 的 max-width），画布都会跟着重算，
    // 不会出现「画布尺寸停留在旧宽度、内容整体偏向一侧」的问题。
    var stage = this.canvas.parentNode;
    if (global.ResizeObserver) {
      this._ro = new global.ResizeObserver(function () { self.resize(); });
      this._ro.observe(stage);
    } else {
      global.addEventListener('resize', function () { self.resize(); });
    }
    this.bindKeys();
  }

  /* ---------- 布局 ---------- */
  Game.prototype.resize = function () {
    var stage = this.canvas.parentNode;
    var cssW = stage.clientWidth;
    var cssH = stage.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    var dpr = Math.min(global.devicePixelRatio || 1, 2.5);
    this.dpr = dpr;
    this.canvas._dpr = dpr;
    this.canvas.width = Math.floor(cssW * dpr);
    this.canvas.height = Math.floor(cssH * dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var cell = Math.floor(Math.min((cssW - 14) / this.board.cols, (cssH - 14) / this.board.rows));
    this.layout.cell = cell;
    this.layout.cols = this.board.cols;
    this.layout.rows = this.board.rows;
    this.layout.x = Math.round((cssW - cell * this.board.cols) / 2);
    this.layout.y = Math.round((cssH - cell * this.board.rows) / 2);
    this.layout.w = cssW;
    this.layout.h = cssH;
    this.renderer.setLayout(this.layout);
  };

  /* ---------- 手势接线 ---------- */
  Game.prototype.setupGesture = function () {
    var self = this;
    this.gesture = new TZ.Gesture(this.canvas, {
      isBusy: function () {
        return self.state !== STATE.PLAYING;
      },
      getCell: function () { return self.layout.cell; },
      getOrigin: function () { return { x: self.layout.x, y: self.layout.y }; },

      hitPiece: function (px, py) {
        if (!self.piece) return null;
        var L = self.layout, b = self.board.buffer;
        var cells = self.piece.cells();
        var tol = L.cell * 0.5;
        for (var i = 0; i < cells.length; i++) {
          var rx = L.x + cells[i][0] * L.cell;
          var ry = L.y + (cells[i][1] - b) * L.cell;
          var ddx = Math.max(rx - px, 0, px - (rx + L.cell));
          var ddy = Math.max(ry - py, 0, py - (ry + L.cell));
          if (ddx * ddx + ddy * ddy <= tol * tol) {
            var gx = Math.floor((px - L.x) / L.cell);
            return { offsetCol: gx - self.piece.x };
          }
        }
        return null;
      },

      onMove: function (dir) { return self.move(dir); },
      onRotate: function (dir) { return self.rotate(dir); },
      onTapPiece: function () { self.rotate(1); },

      onNavStart: function () {
        self.navTarget = null;
        self.audio.navigate();
      },
      onNavUpdate: function (col) { self.updateNavTarget(col); },
      onNavCommit: function (col) { self.commitNav(col); },
      onNavCancel: function () { self.navTarget = null; },

      onChargeStart: function () { self.audio.charge(); },
      onChargeRelease: function (power) { self.fire(power); },
      onChargeCancel: function () { }
    });
    this.gesture.attach();
  };

  /* 键盘：桌面调试与备用操作 */
  Game.prototype.bindKeys = function () {
    var self = this;
    global.addEventListener('keydown', function (e) {
      if (self.state === STATE.READY || self.state === STATE.OVER) {
        if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); self.start(); }
        return;
      }
      if (e.code === 'KeyP' || e.code === 'Escape') { self.togglePause(); return; }
      if (self.state !== STATE.PLAYING) return;
      switch (e.code) {
        case 'ArrowLeft': self.move(-1); e.preventDefault(); break;
        case 'ArrowRight': self.move(1); e.preventDefault(); break;
        case 'ArrowUp': case 'KeyX': self.rotate(1); e.preventDefault(); break;
        case 'KeyZ': self.rotate(-1); e.preventDefault(); break;
        case 'ArrowDown': self.softDrop(); e.preventDefault(); break;
        case 'Space': self.fire(1); e.preventDefault(); break;
      }
    });
  };

  /* ---------- 生命周期 ---------- */
  Game.prototype.start = function () {
    this.board = new TZ.Board();
    this.bag = new TZ.Bag();
    this.score = 0; this.lines = 0; this.level = 0; this.combo = -1;
    this.dropAcc = 0; this.lockTimer = 0; this.lockResets = 0; this.grounded = false;
    this.navTarget = null; this.navQueue = null; this.launch = null; this.clearInfo = null;
    this.particles.clear(); this.floaters.clear();
    this.audio.ensure();
    this.state = STATE.PLAYING;
    this.spawn();
    this.ui.hideOverlay();
    this.syncHud();
  };

  Game.prototype.spawn = function () {
    this.piece = new TZ.Piece(this.bag.next());
    // 生成在可见区第一行，否则新块藏在缓冲区里，玩家既看不见也抓不到
    this.piece.y = this.board.buffer;
    this.dropAcc = 0; this.lockTimer = 0; this.lockResets = 0; this.grounded = false;
    this.ui.renderNext(this.bag.peek(1));
    if (this.board.isTopOut(this.piece)) {
      this.piece.y = this.board.buffer - 1;   // 顶部拥挤时允许上移一格再试
      if (this.board.isTopOut(this.piece)) this.gameOver();
    }
  };

  Game.prototype.gameOver = function () {
    this.state = STATE.OVER;
    this.audio.over();
    this.shake.add(18);
    if (this.score > this.best) {
      this.best = this.score;
      try { localStorage.setItem('tz_best', String(this.best)); } catch (e) { }
    }
    this.ui.showOver(this.score, this.lines, this.best);
    this.syncHud();
  };

  Game.prototype.togglePause = function () {
    if (this.state === STATE.PLAYING) {
      this.state = STATE.PAUSED;
      this.ui.showPause();
    } else if (this.state === STATE.PAUSED) {
      this.state = STATE.PLAYING;
      this.ui.hideOverlay();
    }
  };

  /* ---------- 基础操作 ---------- */
  Game.prototype.move = function (dir) {
    if (!this.piece || this.state !== STATE.PLAYING) return false;
    if (this.board.collides(this.piece, this.piece.rot, this.piece.x + dir, this.piece.y)) return false;
    this.piece.x += dir;
    this.audio.move();
    this.touchLockReset();
    return true;
  };

  Game.prototype.rotate = function (dir) {
    if (!this.piece || this.state !== STATE.PLAYING) return false;
    var r = this.board.tryRotate(this.piece, dir);
    if (!r) return false;
    this.piece.rot = r.rot; this.piece.x = r.x; this.piece.y = r.y;
    this.audio.rotate();
    this.touchLockReset();
    if (r.kickIndex > 0) {
      // 踢墙成功时给一点视觉反馈
      var L = this.layout;
      var cs = this.piece.cells();
      var cx = 0, cy = 0;
      for (var i = 0; i < cs.length; i++) { cx += cs[i][0]; cy += cs[i][1]; }
      this.particles.burst(
        L.x + (cx / cs.length + 0.5) * L.cell,
        L.y + (cy / cs.length + 0.5 - this.board.buffer) * L.cell,
        this.piece.color, 8, { speed: 1.8, gravity: 0.05, size: 2.5 }
      );
    }
    return true;
  };

  Game.prototype.softDrop = function () {
    if (!this.piece) return;
    if (!this.board.collides(this.piece, this.piece.rot, this.piece.x, this.piece.y + 1)) {
      this.piece.y++;
      this.score += 1;
      this.dropAcc = 0;
      this.syncHud();
    }
  };

  Game.prototype.touchLockReset = function () {
    if (this.grounded && this.lockResets < TZ.CFG.MAX_LOCK_RESET) {
      this.lockTimer = 0;
      this.lockResets++;
    }
  };

  /* ---------- 落点导航 ---------- */
  Game.prototype.clampCol = function (col, rot) {
    var shape = TZ.SHAPES[this.piece.type][rot];
    var minX = 9, maxX = -9;
    for (var i = 0; i < shape.length; i++) {
      minX = Math.min(minX, shape[i][0]); maxX = Math.max(maxX, shape[i][0]);
    }
    return Math.max(-minX, Math.min(this.board.cols - 1 - maxX, col));
  };

  /* 预览即结果：直接用寻路的真实终点作为预览，
   * 避免「预览显示 A，松手却落到 B」的割裂感。路径一并缓存，松手时直接播放。 */
  Game.prototype.updateNavTarget = function (col) {
    if (!this.piece) return;
    var tx = this.clampCol(col, this.piece.rot);
    if (this.navTarget && this.navTarget.col === tx) return;
    var res = this.board.findPath(this.piece, tx, this.piece.rot);
    if (!res) return;
    this.navTarget = {
      col: tx, x: res.x, y: res.y, rot: res.rot,
      path: res.path, exact: res.exact
    };
    this.audio.move();
  };

  Game.prototype.commitNav = function () {
    var t = this.navTarget;
    this.navTarget = null;
    if (!this.piece || !t || !t.path || !t.path.length) return;
    this.navQueue = t.path;
    this.navStep = 0;
    this.navAcc = 0;
    this.state = STATE.NAVIGATING;
    this.audio.navigate();
  };

  Game.prototype.stepNav = function (dt) {
    this.navAcc += dt;
    var interval = 26;
    while (this.navAcc >= interval && this.navQueue && this.navStep < this.navQueue.length) {
      this.navAcc -= interval;
      var op = this.navQueue[this.navStep++];
      if (op === 'L') { if (!this.board.collides(this.piece, this.piece.rot, this.piece.x - 1, this.piece.y)) this.piece.x--; }
      else if (op === 'R') { if (!this.board.collides(this.piece, this.piece.rot, this.piece.x + 1, this.piece.y)) this.piece.x++; }
      else if (op === 'D') { if (!this.board.collides(this.piece, this.piece.rot, this.piece.x, this.piece.y + 1)) this.piece.y++; }
      else if (op === 'CW' || op === 'CCW') {
        var r = this.board.tryRotate(this.piece, op === 'CW' ? 1 : -1);
        if (r) { this.piece.rot = r.rot; this.piece.x = r.x; this.piece.y = r.y; }
      } else if (op === 'DROP') {
        this.piece.y = this.board.dropY(this.piece);
        this.navQueue = null;
        this.state = STATE.PLAYING;
        this.lockPiece(0.35);
        return;
      }
    }
    if (this.navQueue && this.navStep >= this.navQueue.length) {
      this.navQueue = null;
      this.state = STATE.PLAYING;
    }
  };

  /* ---------- 蓄力弹射 ---------- */
  Game.prototype.fire = function (power) {
    if (!this.piece || (this.state !== STATE.PLAYING)) return;
    power = Math.max(0.12, Math.min(1, power));
    var targetY = this.board.dropY(this.piece);
    var dist = targetY - this.piece.y;
    this.launch = {
      power: power,
      targetY: targetY,
      from: this.piece.y,
      progress: 0,
      speed: (0.06 + power * 0.34) / Math.max(1, dist * 0.06)
    };
    this.state = STATE.LAUNCHING;
    this.audio.launch(power);
    this.score += Math.floor(dist * (1 + power));
  };

  Game.prototype.stepLaunch = function (dt) {
    var lc = this.launch;
    if (!lc) { this.state = STATE.PLAYING; return; }
    lc.progress += lc.speed * (dt / 16.7);
    if (lc.progress >= 1) {
      this.piece.y = lc.targetY;
      var p = lc.power;
      this.launch = null;
      this.state = STATE.PLAYING;
      this.shake.add(5 + 16 * p);
      // 落地冲击粒子
      var L = this.layout, b = this.board.buffer;
      var cells = this.piece.cells();
      for (var i = 0; i < cells.length; i++) {
        var gy = cells[i][1] - b;
        if (gy < 0) continue;
        this.particles.burst(
          L.x + (cells[i][0] + 0.5) * L.cell,
          L.y + (gy + 1) * L.cell,
          this.piece.color,
          Math.floor(5 + 12 * p),
          { dir: -Math.PI / 2, spread: Math.PI * 1.1, speed: 1.6 + 3.4 * p, size: 3, gravity: 0.22 }
        );
      }
      if (p > 0.85) {
        this.floaters.add(L.x + L.cols * L.cell / 2, L.y + (this.piece.y - b) * L.cell, '重击 +' + Math.floor(p * 50), '#ffd84d', 18);
        this.score += Math.floor(p * 50);
      }
      this.lockPiece(p);
    } else {
      this.piece.y = lc.from + (lc.targetY - lc.from) * Math.min(1, lc.progress);
    }
  };

  /* ---------- 锁定与消行 ---------- */
  Game.prototype.lockPiece = function (impact) {
    this.piece.y = Math.round(this.piece.y);
    var L = this.layout, b = this.board.buffer;
    this.board.lock(this.piece);
    this.audio.lock();
    if (!impact) this.shake.add(2.5);

    var full = this.board.fullRows();
    if (full.length) {
      this.state = STATE.CLEARING;
      this.clearInfo = { rows: full, t: 0, dur: 240 };
      // 整行迸发粒子
      for (var i = 0; i < full.length; i++) {
        var y = full[i] - b;
        if (y < 0) continue;
        for (var x = 0; x < this.board.cols; x++) {
          var c = this.board.grid[full[i]][x];
          this.particles.burst(
            L.x + (x + 0.5) * L.cell,
            L.y + (y + 0.5) * L.cell,
            c ? c.color : '#fff', 6,
            { speed: 3.2, size: 3.4, gravity: 0.16 }
          );
        }
      }
      var names = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'TETRIS'];
      var color = full.length === 4 ? '#ffd84d' : '#ffffff';
      this.floaters.add(L.x + L.cols * L.cell / 2, L.y + (full[0] - b) * L.cell, names[full.length], color, full.length === 4 ? 26 : 20);
      this.audio.clear(full.length);
      this.shake.add(4 + full.length * 3.5);
    } else {
      this.combo = -1;
      this.spawn();
    }
  };

  Game.prototype.stepClearing = function (dt) {
    var ci = this.clearInfo;
    ci.t += dt;
    if (ci.t < ci.dur) return;
    var n = ci.rows.length;
    this.board.clearRows(ci.rows);
    this.lines += n;
    this.combo++;
    this.level = Math.floor(this.lines / 10);
    var gained = TZ.scoreFor(n, this.level, false);
    if (this.combo > 0) gained += 50 * this.combo * (this.level + 1);
    this.score += gained;
    this.clearInfo = null;
    this.state = STATE.PLAYING;
    this.syncHud();
    this.spawn();
  };

  /* ---------- 主循环 ---------- */
  Game.prototype.update = function (dt) {
    this.time += dt;
    this.gesture.tick(dt);
    this.particles.update();
    this.shake.update();
    this.floaters.update();

    if (this.state === STATE.CLEARING) { this.stepClearing(dt); return; }
    if (this.state === STATE.NAVIGATING) { this.stepNav(dt); return; }
    if (this.state === STATE.LAUNCHING) { this.stepLaunch(dt); return; }
    if (this.state !== STATE.PLAYING || !this.piece) return;

    var g = this.gesture.getState();
    // 瞄准中冻结重力：导航与蓄力都需要稳定的参照
    if (g.mode === 'NAVIGATE' || g.mode === 'CHARGE') return;

    var interval = Math.max(70, TZ.CFG.DROP_BASE - this.level * 85);
    this.dropAcc += dt;

    var canFall = !this.board.collides(this.piece, this.piece.rot, this.piece.x, this.piece.y + 1);
    if (canFall) {
      this.grounded = false;
      this.lockTimer = 0;
      if (this.dropAcc >= interval) {
        this.dropAcc = 0;
        this.piece.y++;
      }
    } else {
      if (!this.grounded) { this.grounded = true; this.lockResets = 0; }
      this.lockTimer += dt;
      if (this.lockTimer >= TZ.CFG.LOCK_DELAY) this.lockPiece(0);
    }
  };

  Game.prototype.draw = function () {
    var ctx = this.ctx, L = this.layout;
    ctx.clearRect(0, 0, L.w, L.h);
    ctx.save();
    ctx.translate(this.shake.x, this.shake.y);

    this.renderer.field();

    var flashRows = this.clearInfo ? this.clearInfo.rows : null;
    var flashT = this.clearInfo ? this.clearInfo.t / this.clearInfo.dur : 0;
    this.renderer.stack(this.board, flashRows, flashT);

    if (this.piece && this.state !== STATE.OVER && this.state !== STATE.READY) {
      var g = this.gesture.getState();
      var b = this.board.buffer;

      if (g.mode === 'NAVIGATE' && this.navTarget) {
        this.renderer.navigation(this.piece, this.navTarget.x, this.navTarget.rot, this.navTarget.y, b, this.time);
      } else if (this.state === STATE.PLAYING || this.state === STATE.PAUSED) {
        this.renderer.ghost(this.piece, this.board.dropY(this.piece), b);
      }

      var glow = g.mode === 'NAVIGATE' ? 0.55 : (g.mode === 'CHARGE' ? 0.3 + g.charge * 0.6 : 0);
      this.renderer.piece(this.piece, b, { glow: glow || undefined });

      // 皮筋要覆盖在方块之上，才有「兜住方块」的层次感
      if (g.mode === 'CHARGE') {
        this.renderer.slingshot(this.piece, g.charge, b, this.board.dropY(this.piece));
      }
    }

    this.particles.draw(ctx);
    this.floaters.draw(ctx);
    ctx.restore();
  };

  Game.prototype.syncHud = function () {
    this.ui.setStats(this.score, this.level, this.lines, this.best);
  };

  Game.prototype.loop = function () {
    var self = this;
    var last = performance.now();
    function frame(now) {
      var dt = Math.min(50, now - last);
      last = now;
      self.update(dt);
      self.draw();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  };

  Game.STATE = STATE;
  TZ.Game = Game;

})(typeof window !== 'undefined' ? window : this);

/* @author wangzhuo <mail_zhuo@163.com> - 魔方坠落 Gesture Tetris | 版权所有，翻版必究 */
