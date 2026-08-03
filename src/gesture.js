/*!
 * ============================================================================
 *  魔方坠落 · 手势俄罗斯方块  (Gesture Tetris)
 * ----------------------------------------------------------------------------
 *  @file         src/gesture.js
 *  @description  单指手势状态机（横移 / 旋转 / 落点导航 / 蓄力弹射）
 *  @author       wangzhuo <mail_zhuo@163.com>
 *  @contact      mail_zhuo@163.com
 *  @copyright    Copyright (c) 2026 wangzhuo. All rights reserved.
 *  @license      本项目为 wangzhuo 原创作品，受著作权法保护。
 *                未经作者书面许可，不得复制、修改、分发或用于任何商业用途。
 * ============================================================================
 *
 * gesture.js - 单指手势状态机
 *
 * 四种操作共用一根手指，靠「触点归属 + 位移方向 + 停留时长」三重判定分流：
 *
 *   按下 ─┬─ 命中活动方块 ─┬─ 停留 200ms 无位移 ──→ NAVIGATE 落点导航
 *         │                ├─ 横向位移超阈值 ────→ MOVE 逐格横移
 *         │                └─ 上滑超阈值 ────────→ ROTATE 旋转（左偏逆时针/右偏顺时针）
 *         └─ 落在空白处 ───┬─ 停留 200ms 无位移 ──→ CHARGE 蓄力弹射
 *                          ├─ 横向位移超阈值 ────→ MOVE（空白处也可横滑，操作面积更大）
 *                          └─ 上滑超阈值 ────────→ ROTATE
 *
 * CHARGE 是「边蓄力边瞄准」的复合态：力度只由按住时长决定，横向滑动仍逐格
 * 带动方块，玩家可以在蓄满的同时把落点挪到想要的列，不必松手重来。
 *
 * 判定逻辑与事件绑定解耦：handleDown/handleMove/handleUp 是纯逻辑，
 * 迁移到小程序时只需替换 attach() 里的事件监听层。
 */
(function (global) {
  'use strict';
  var TZ = global.TZ || (global.TZ = {});

  var P = {
    HOLD_MS: 200,        // 长按判定时长
    HOLD_TOL: 10,        // 长按期间允许的抖动像素
    MOVE_RATIO: 0.55,    // 横移阈值 = 格子宽 * 该系数
    ROT_RATIO: 0.85,     // 首次旋转阈值 = 格子宽 * 该系数，明显高于手指抖动幅度
    ROT_REPEAT: 1.7,     // 连续旋转所需的「额外」位移，远高于首次，避免一滑连转
    ROT_BACK: 1.9,       // 回拉反向旋转阈值，最保守，防止抖动来回翻转
    ROT_COOLDOWN: 260,   // 两次旋转之间的最小间隔（ms），硬性限制触发频次
    ROT_BIAS_SLOPE: 0.35,// 转向判定用「滑动角度」dx/ady，比绝对像素更稳定
    ROT_LOCK: 1.35,      // 旋转需纵向分量超横向该倍数（收紧，斜滑不再误判为旋转）
    MOVE_LOCK: 1.0,      // 横移只需横向占优即可（放宽，避免与旋转之间出现死区）
    CHARGE_MS: 850,      // 蓄满所需时长
    CHARGE_MOVE: 1.15,   // 蓄力期间横移步长（格）。手指处于按压状态抖动更大，
                         // 比常规横移略钝一点，既能瞄准又不会误触
    TAP_MS: 180,         // 轻点判定
    TAP_DIST: 10
  };

  /* hooks 需要提供：
   *   getCell()    -> 格子边长（像素）
   *   getOrigin()  -> {x, y} 棋盘左上角在 canvas 内的坐标
   *   hitPiece(cx, cy) -> 触点是否命中活动方块，命中返回 {gx, gy}，否则 null
   *   onMove(dir)          横移一格
   *   onRotate(dir)        旋转，dir=1 顺时针 / -1 逆时针
   *   onNavStart()         进入导航模式
   *   onNavUpdate(col)     导航目标列变化
   *   onNavCommit(col)     松手，执行导航
   *   onNavCancel()
   *   onChargeStart()
   *   onChargeRelease(power)  power 为 0~1
   *   onChargeCancel()
   *   onTapPiece()         轻点方块
   *   isBusy()             游戏是否处于不可操作状态
   */
  function Gesture(el, hooks) {
    this.el = el;
    this.h = hooks;
    this.reset();
    this.charge = 0;
    this.charging = false;
  }

  Gesture.prototype.reset = function () {
    this.active = false;
    this.mode = 'NONE';      // NONE | PENDING | MOVE | ROTATE | NAVIGATE | CHARGE
    this.startX = 0;
    this.startY = 0;
    this.startTime = 0;
    this.lastX = 0;
    this.lastY = 0;
    this.anchorX = 0;        // 横移步进锚点
    this.anchorY = 0;        // 旋转步进锚点
    this.onPiece = false;
    this.grabOffset = 0;     // 抓取点相对方块左上角的列偏移
    this.rotDir = 1;
    this.lastRotTime = 0;    // 上次旋转的时间戳，用于冷却判定
    this.navCol = null;
    this.charging = false;
    this.charge = 0;
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
  };

  /* ---------- 事件绑定层（Web） ---------- */
  Gesture.prototype.attach = function () {
    var self = this;
    var el = this.el;

    function pos(e) {
      var r = el.getBoundingClientRect();
      var sx = el.width / r.width;      // 处理 DPR 与 CSS 缩放
      var sy = el.height / r.height;
      var src = e.touches && e.touches[0] ? e.touches[0] : e;
      return {
        x: (src.clientX - r.left) * sx / (el._dpr || 1),
        y: (src.clientY - r.top) * sy / (el._dpr || 1)
      };
    }

    function down(e) {
      e.preventDefault();
      var p = pos(e);
      self.handleDown(p.x, p.y, Date.now());
    }
    function move(e) {
      if (!self.active) return;
      e.preventDefault();
      var p = pos(e);
      self.handleMove(p.x, p.y, Date.now());
    }
    function up(e) {
      if (!self.active) return;
      e.preventDefault();
      self.handleUp(Date.now());
    }

    if (global.PointerEvent) {
      el.addEventListener('pointerdown', function (e) { el.setPointerCapture && el.setPointerCapture(e.pointerId); down(e); });
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    } else {
      el.addEventListener('touchstart', down, { passive: false });
      el.addEventListener('touchmove', move, { passive: false });
      el.addEventListener('touchend', up, { passive: false });
      el.addEventListener('mousedown', down);
      global.addEventListener('mousemove', move);
      global.addEventListener('mouseup', up);
    }
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  };

  /* ---------- 判定逻辑层（可移植） ---------- */
  Gesture.prototype.handleDown = function (x, y, t) {
    if (this.h.isBusy && this.h.isBusy()) return;
    this.reset();
    this.active = true;
    this.mode = 'PENDING';
    this.startX = this.lastX = this.anchorX = x;
    this.startY = this.lastY = this.anchorY = y;
    this.startTime = t;

    var hit = this.h.hitPiece(x, y);
    this.onPiece = !!hit;
    if (hit) this.grabOffset = hit.offsetCol;

    var self = this;
    this.holdTimer = setTimeout(function () {
      if (!self.active || self.mode !== 'PENDING') return;
      var dx = Math.abs(self.lastX - self.startX);
      var dy = Math.abs(self.lastY - self.startY);
      if (dx > P.HOLD_TOL || dy > P.HOLD_TOL) return;
      if (self.onPiece) {
        self.mode = 'NAVIGATE';
        self.navCol = self.colAt(self.lastX);
        self.h.onNavStart();
        self.h.onNavUpdate(self.navCol);
      } else {
        self.mode = 'CHARGE';
        self.charging = true;
        self.charge = 0;
        self.anchorX = self.lastX;   // 以进入蓄力那一刻为横移起点，抵消长按期间的手指漂移
        self.h.onChargeStart();
      }
    }, P.HOLD_MS);
  };

  Gesture.prototype.colAt = function (x) {
    var cell = this.h.getCell();
    var origin = this.h.getOrigin();
    return Math.round((x - origin.x) / cell - this.grabOffset);
  };

  Gesture.prototype.handleMove = function (x, y, t) {
    if (!this.active) return;
    this.lastX = x; this.lastY = y;
    var cell = this.h.getCell();

    if (this.mode === 'PENDING') {
      var dx = x - this.startX;
      var dy = y - this.startY;
      var adx = Math.abs(dx), ady = Math.abs(dy);
      var elapsed = t - this.startTime;

      // 长按时间已到，优先判定为导航/蓄力而不是移动/旋转，因为意图已明确
      if (elapsed >= P.HOLD_MS) {
        clearTimeout(this.holdTimer);
        if (this.onPiece) {
          this.mode = 'NAVIGATE';
          this.navCol = this.colAt(x);
          this.h.onNavStart();
          this.h.onNavUpdate(this.navCol);
        } else {
          this.mode = 'CHARGE';
          this.charging = true; this.charge = 0;
          this.anchorX = x;
          this.h.onChargeStart();
        }
        return;
      }

      // 上滑旋转：纵向明显占优且方向朝上，阈值高于手指抖动幅度。
      if (dy < 0 && ady > cell * P.ROT_RATIO && ady > adx * P.ROT_LOCK) {
        this.mode = 'ROTATE';
        clearTimeout(this.holdTimer);
        // 用滑动角度而非绝对像素判定转向：触发瞬间横向分量尚未展开完，
        // 用比值才能稳定反映玩家真实的斜滑意图。
        this.rotDir = (dx / ady) < -P.ROT_BIAS_SLOPE ? -1 : 1;
        this.h.onRotate(this.rotDir);
        this.anchorY = y;
        this.lastRotTime = t;
        return;
      }
      // 横向移动
      if (adx > cell * P.MOVE_RATIO && adx > ady * P.MOVE_LOCK) {
        this.mode = 'MOVE';
        clearTimeout(this.holdTimer);
        this.anchorX = this.startX;
        this.stepMove(x, cell);
        return;
      }
      return;
    }

    if (this.mode === 'MOVE') { this.stepMove(x, cell); return; }

    if (this.mode === 'ROTATE') {
      // 连续旋转受两道闸门约束：时间冷却 + 明显更大的额外位移。
      // 这样「一次长滑」最多转一两下，手指抖动完全不会累积触发。
      if (t - this.lastRotTime < P.ROT_COOLDOWN) return;
      var up = this.anchorY - y;
      if (up > cell * P.ROT_REPEAT) {
        this.h.onRotate(this.rotDir);
        this.anchorY = y;
        this.lastRotTime = t;
      } else if (y - this.anchorY > cell * P.ROT_BACK) {
        // 明确回拉才反向旋转，用于转过头时的微调
        this.h.onRotate(-this.rotDir);
        this.anchorY = y;
        this.lastRotTime = t;
      }
      return;
    }

    if (this.mode === 'NAVIGATE') {
      var col = this.colAt(x);
      if (col !== this.navCol) {
        this.navCol = col;
        this.h.onNavUpdate(col);
      }
      return;
    }

    if (this.mode === 'CHARGE') {
      // 蓄力与瞄准并行：横向滑动继续逐格移动方块，力度依旧只由按住时长决定。
      // 步长比常规横移大一档，因为此时手指是「压住不动」的姿势，抖动幅度更大。
      this.stepMove(x, cell * P.CHARGE_MOVE);
      return;
    }
  };

  /* 按 step 像素为一格逐级推进横移，锚点随之滚动，多格滑动会连续触发。
   * eps 抵消锚点累加带来的浮点误差：位移正好是整格倍数时不能漏掉最后一格。 */
  Gesture.prototype.stepMove = function (x, step) {
    var guard = 0;
    var eps = step * 1e-6;
    while (x - this.anchorX >= step - eps && guard++ < 20) {
      var ok = this.h.onMove(1);
      this.anchorX += step;
      if (!ok) { this.anchorX = x; break; }   // 撞墙则重置锚点，避免位移累积
    }
    while (this.anchorX - x >= step - eps && guard++ < 20) {
      var ok2 = this.h.onMove(-1);
      this.anchorX -= step;
      if (!ok2) { this.anchorX = x; break; }
    }
  };

  /* 蓄力值由主循环推进 */
  Gesture.prototype.tick = function (dt) {
    if (this.mode === 'CHARGE' && this.charging) {
      this.charge = Math.min(1, this.charge + dt / P.CHARGE_MS);
    }
  };

  Gesture.prototype.handleUp = function (t) {
    if (!this.active) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;

    var mode = this.mode;
    var dur = t - this.startTime;
    var dist = Math.abs(this.lastX - this.startX) + Math.abs(this.lastY - this.startY);

    if (mode === 'NAVIGATE') {
      this.h.onNavCommit(this.navCol);
    } else if (mode === 'CHARGE') {
      this.h.onChargeRelease(this.charge);
    } else if (mode === 'PENDING' && dur < P.TAP_MS && dist < P.TAP_DIST) {
      // 轻点方块 = 快速顺时针旋转
      if (this.onPiece) this.h.onTapPiece();
    }

    this.active = false;
    this.mode = 'NONE';
    this.charging = false;
    this.charge = 0;
  };

  Gesture.prototype.getState = function () {
    return { mode: this.mode, charge: this.charge, navCol: this.navCol, rotDir: this.rotDir };
  };

  Gesture.PARAMS = P;
  TZ.Gesture = Gesture;

})(typeof window !== 'undefined' ? window : this);

/* @author wangzhuo <mail_zhuo@163.com> - 魔方坠落 Gesture Tetris | 版权所有，翻版必究 */
