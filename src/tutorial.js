/*!
 * ============================================================================
 *  魔方坠落 · 手势俄罗斯方块  (Gesture Tetris)
 * ----------------------------------------------------------------------------
 *  @file         src/tutorial.js
 *  @description  首玩新手引导：分步骤教练式实操教程（每个操作都必须亲手完成）
 *  @author       wangzhuo <mail_zhuo@163.com>
 *  @contact      mail_zhuo@163.com
 *  @copyright    Copyright (c) 2026 wangzhuo. All rights reserved.
 *  @license      本项目为 wangzhuo 原创作品，受著作权法保护。
 *                未经作者书面许可，不得复制、修改、分发或用于任何商业用途。
 * ============================================================================
 *
 *  tutorial.js - 新手引导状态机
 *
 *  思路（业内通用的「交互式教练层 / Interactive Coach-Mark」）：
 *   - 首次启动且 localStorage 未标记完成时进入，每个操作单独成步。
 *   - 每步在棋盘上用「幽灵手指」循环演示该手势，玩家必须真正做出对应手势才算通过。
 *   - 手势引擎照常运行，但事件先被本层拦截并按「当前步 key」判定，避免串步误通过。
 *   - 全部通过 → 写 localStorage 标记 → 正式开局。
 */
(function (global) {
  'use strict';
  var TZ = global.TZ || (global.TZ = {});

  /* 五个步骤，顺序与首页操作提示保持一致 */
  var STEPS = [
    { key: 'move',   iconKey: 'move',   title: '左右横滑移动',   demo: 'move',   desc: '在棋盘任意处左右滑动，方块会逐格跟手移动。' },
    { key: 'rotate', iconKey: 'rotate', title: '向上滑动旋转',   demo: 'rotate', desc: '手指放在方块左侧上滑=顺时针，右侧上滑=逆时针。' },
    { key: 'dtap',   iconKey: 'dtap',   title: '空白处双击旋转', demo: 'dtap',   desc: '在空白区域快速双击，方块一律顺时针转一次。' },
    { key: 'nav',    iconKey: 'nav',    title: '按住方块拖到落点', demo: 'nav',    desc: '长按方块不放，拖动到想落的列，松手自动寻路就位。' },
    { key: 'charge', iconKey: 'charge', title: '长按空白蓄力弹射', demo: 'charge', desc: '在空白处按住不放蓄力，松手把方块弹射下去。' }
  ];

  var STORE_KEY = 'tz_tutorial_done';

  function Tutorial(game) {
    this.game = game;
    this.ui = game.ui;
    this.active = false;
    this.step = 0;
    this.t = 0;            // 演示动画时间（秒）
    this.passed = false;   // 当前步是否已通过（用于打勾与防抖）
    this.passTimer = 0;    // 通过后停留时长，到时进入下一步
    this.navMoved = false; // 导航步：是否真的拖动过（防止「长按松手」被误判通过）
    this.practice = null;  // 练习用方块
    this.steps = STEPS;
  }

  Tutorial.isDone = function () {
    try { return global.localStorage && localStorage.getItem(STORE_KEY) === '1'; }
    catch (e) { return false; }
  };
  Tutorial.markDone = function () {
    try { localStorage.setItem(STORE_KEY, '1'); } catch (e) {}
  };

  Tutorial.prototype.key = function () { return this.steps[this.step].key; };

  Tutorial.prototype.start = function () {
    this.active = true;
    this.step = 0;
    this.t = 0;
    this.game.state = TZ.Game.STATE.PLAYING;
    this.game.board = new TZ.Board();          // 干净的空棋盘
    this.game.navTarget = null;
    this.game.launch = null;
    this.game.rotFx = null;
    this.ui.showTutorial();
    this.resetStep();
  };

  Tutorial.prototype.resetStep = function () {
    var b = this.game.board.buffer;
    this.practice = new TZ.Piece('T');
    this.practice.x = 3;          // T 型占据列 3~5，中心列 4
    this.practice.y = b + 3;      // 偏上，露出上下空间，便于演示
    this.practice.rot = 0;
    this.game.piece = this.practice;
    this.game.navTarget = null;
    this.passed = false;
    this.navMoved = false;
    this.passTimer = 0;

    var s = this.steps[this.step];
    var icon = (TZ.icons && TZ.icons[s.iconKey]) || '';
    this.ui.showTutorialStep(
      { icon: icon, title: s.title, desc: s.desc },
      this.step,
      this.steps.length
    );
  };

  Tutorial.prototype.pass = function () {
    if (this.passed) return;
    this.passed = true;
    this.passTimer = 650;
    this.ui.setTutorialStatus('✓ 完成！', 'ok');
  };

  Tutorial.prototype.next = function () {
    this.step++;
    if (this.step >= this.steps.length) { this.finish(); return; }
    this.resetStep();
  };

  Tutorial.prototype.finish = function () {
    this.active = false;
    Tutorial.markDone();
    this.game.piece = null;
    this.ui.hideTutorial();
    this.game.start();          // 正式开局
  };

  Tutorial.prototype.skip = function () {
    if (!this.active) return;
    this.active = false;
    Tutorial.markDone();
    this.game.piece = null;
    this.ui.hideTutorial();
    this.game.start();
  };

  /* ---------- 主循环钩子 ---------- */
  Tutorial.prototype.tick = function (dt) {
    this.t += dt / 1000;
    if (this.passed) {
      this.passTimer -= dt;
      if (this.passTimer <= 0) this.next();
    }
  };

  /* ---------- 手势事件（由 game.js 的 hook 转发） ---------- */
  Tutorial.prototype.onMove = function (dir) {
    if (this.passed || this.key() !== 'move') return;
    this.game.move(dir);
    this.pass();
  };
  Tutorial.prototype.onRotate = function (dir) {
    if (this.passed || this.key() !== 'rotate') return;
    this.game.rotate(dir);
    this.pass();
  };
  Tutorial.prototype.onTapPiece = function () { /* 教程中不接收单击旋转 */ };
  Tutorial.prototype.onDoubleTap = function () {
    if (this.passed || this.key() !== 'dtap') return;
    this.game.rotate(1);
    this.pass();
  };
  Tutorial.prototype.onNavStart = function () { this.navMoved = false; };
  Tutorial.prototype.onNavUpdate = function (col) {
    if (this.key() !== 'nav') return;
    this.navMoved = true;
    this.game.updateNavTarget(col);
  };
  Tutorial.prototype.onNavCommit = function (col) {
    if (this.passed || this.key() !== 'nav') return;
    if (!this.navMoved) return;        // 必须真的拖动过，仅长按松手不算
    this.practice.x = col;
    this.pass();
  };
  Tutorial.prototype.onNavCancel = function () {
    if (this.key() === 'nav') this.game.navTarget = null;
  };
  Tutorial.prototype.onChargeStart = function () {};
  Tutorial.prototype.onChargeRelease = function () {
    if (this.passed || this.key() !== 'charge') return;
    this.pass();
  };

  /* ---------- 演示「幽灵手指」绘制 ---------- */
  Tutorial.prototype.pieceCenter = function () {
    var L = this.game.layout, p = this.practice, b = this.game.board.buffer;
    var cs = p.cells();
    var mnx = 99, mxx = -99, mny = 99, mxy = -99;
    for (var i = 0; i < cs.length; i++) {
      if (cs[i][0] < mnx) mnx = cs[i][0];
      if (cs[i][0] > mxx) mxx = cs[i][0];
      if (cs[i][1] < mny) mny = cs[i][1];
      if (cs[i][1] > mxy) mxy = cs[i][1];
    }
    return {
      x: L.x + (mnx + mxx + 1) / 2 * L.cell,
      y: L.y + ((mny + mxy + 1) / 2 - b) * L.cell
    };
  };

  function drawHand(ctx, x, y, press, color, cell) {
    ctx.save();
    if (press) {
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(x, y, cell * 0.95, 0, Math.PI * 2);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(x, y, cell * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, cell * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.restore();
  }

  function arrow(ctx, x0, y0, x1, y1, color, cell) {
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = Math.max(2, cell * 0.09);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    var a = Math.atan2(y1 - y0, x1 - x0), hl = cell * 0.4;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - hl * Math.cos(a - 0.5), y1 - hl * Math.sin(a - 0.5));
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - hl * Math.cos(a + 0.5), y1 - hl * Math.sin(a + 0.5));
    ctx.stroke();
    ctx.restore();
  }

  Tutorial.prototype.drawDemo = function (ctx, L) {
    if (!this.practice) return;
    var c = this.pieceCenter();
    var cell = L.cell;
    var color = this.practice.color;
    var loop = 2.6;
    var ph = (this.t % loop) / loop;
    ctx.save();

    switch (this.steps[this.step].demo) {
      case 'move': {
        var hx = c.x + Math.sin(ph * Math.PI * 2) * cell * 1.8;
        arrow(ctx, c.x - cell * 1.9, c.y, c.x - cell * 0.5, c.y, 'rgba(255,255,255,0.45)', cell);
        arrow(ctx, c.x + cell * 1.9, c.y, c.x + cell * 0.5, c.y, 'rgba(255,255,255,0.45)', cell);
        drawHand(ctx, hx, c.y, false, color, cell);
        break;
      }
      case 'rotate': {
        var sx = c.x - cell * 1.7, sy = c.y + cell * 2.4;
        var ex = c.x - cell * 1.7, ey = c.y - cell * 0.1;
        var k = Math.min(1, ph / 0.85);
        var hx = sx + (ex - sx) * k, hy = sy + (ey - sy) * k;
        arrow(ctx, sx, sy + cell * 0.4, sx, sy - cell * 0.4, 'rgba(255,255,255,0.45)', cell);
        drawHand(ctx, hx, hy, false, color, cell);
        break;
      }
      case 'dtap': {
        var ex2 = L.x + 8.2 * cell, ey2 = L.y + 1.6 * cell;   // 空白区（右上）
        var press = (ph > 0.08 && ph < 0.20) || (ph > 0.52 && ph < 0.64);
        drawHand(ctx, ex2, ey2, press, color, cell);
        break;
      }
      case 'nav': {
        var tx = c.x + cell * 1.6, ty = c.y + cell * 4.6;
        var hx, hy, press;
        if (ph < 0.12) { hx = c.x; hy = c.y; press = true; }
        else if (ph < 0.7) {
          var kk = (ph - 0.12) / 0.58;
          hx = c.x + (tx - c.x) * kk; hy = c.y + (ty - c.y) * kk; press = true;
        } else { hx = tx; hy = ty; press = false; }
        ctx.save();
        ctx.globalAlpha = 0.4; ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(tx, ty); ctx.stroke();
        ctx.setLineDash([]); ctx.restore();
        drawHand(ctx, hx, hy, press, color, cell);
        break;
      }
      case 'charge': {
        var ex3 = L.x + 1.3 * cell, ey3 = L.y + 9 * cell;       // 空白区（左下）
        drawHand(ctx, ex3, ey3, true, color, cell);
        var rr = cell * (0.5 + 1.3 * Math.min(1, ph / 0.8));
        ctx.save();
        ctx.globalAlpha = 0.6; ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(ex3, ey3, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        break;
      }
    }
    ctx.restore();
  };

  TZ.Tutorial = Tutorial;
  TZ.Tutorial.STEPS = STEPS;

})(typeof window !== 'undefined' ? window : this);

/* @author wangzhuo <mail_zhuo@163.com> - 魔方坠落 Gesture Tetris | 版权所有，翻版必究 */
