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
 *         │                ├─ 上滑超阈值 ────────→ ROTATE 旋转（轴线左顺时针/右逆时针）
 *         │                └─ 快速抬起 ──────────→ 轻点旋转（顺时针一次）
 *         └─ 落在空白处 ───┬─ 停留 200ms 无位移 ──→ CHARGE 蓄力弹射
 *                          ├─ 横向位移超阈值 ────→ MOVE（空白处也可横滑，操作面积更大）
 *                          ├─ 上滑超阈值 ────────→ ROTATE
 *                          └─ 300ms 内二次轻点 ──→ 双击旋转（顺时针一次）
 *
 * CHARGE 是「边蓄力边瞄准」的复合态：力度只由按住时长决定，横向滑动仍逐格
 * 带动方块，玩家可以在蓄满的同时把落点挪到想要的列，不必松手重来。
 *
 * 空白处单击刻意留空（误触无副作用），双击才旋转：方块越落越低时不用回头去
 * 瞄准它，随手在空白双击即可转向。
 *
 * 上滑旋转：方向由「触点落在方块中心轴线的哪一侧」决定——左半区顺时针、右半区逆时针，
 * 像用手推转盘一样直觉。双击旋转则一律顺时针(+1)，不区分左右，便于盲操作。
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
    ROT_BIAS_SLOPE: 0.35,// 仅当 getPieceCenterX 不可用时（无方块）降级用作「滑动角度」dx/ady 判定
    ROT_LOCK: 1.35,      // 旋转需纵向分量超横向该倍数（收紧，斜滑不再误判为旋转）
    MOVE_LOCK: 1.0,      // 横移只需横向占优即可（放宽，避免与旋转之间出现死区）
    CHARGE_MS: 850,      // 蓄满所需时长
    CHARGE_MOVE: 1.15,   // 蓄力期间横移步长（格）。手指处于按压状态抖动更大，
                         // 比常规横移略钝一点，既能瞄准又不会误触
    TAP_MS: 180,         // 轻点判定
    TAP_DIST: 10,
    DTAP_MS: 300,        // 双击间隔上限。比系统 500ms 短，避免「两次独立轻点」被误连成双击
    DTAP_DIST: 34,       // 两次点击的落点容差（像素），略大于一格，允许手指自然漂移
    NAV_FOLLOW_MIN: 0.06 // 长按进入导航后，手指移动超过该格数（约 2.5px，横纵皆可）才切到「手指列跟随」。阈值极小，仅过滤长按松手瞬间的亚像素抖动，确保一滑动就完全跟手
  };

  /* hooks 需要提供：
   *   getCell()    -> 格子边长（像素）
   *   getOrigin()  -> {x, y} 棋盘左上角在 canvas 内的坐标
   *   getPieceCol() -> 活动方块的「视觉中心列」（用于导航起始列，避免触点偏移导致方向偏差）
   *   getPieceCenterX() -> 活动方块中心轴线的像素 X（判定旋转方向的左右半区），无方块返回 null
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
   *   onDoubleTap()        空白处双击，一律顺时针(+1)，不区分屏幕左右半区
   *   isBusy()             游戏是否处于不可操作状态
   */
  function Gesture(el, hooks) {
    this.el = el;
    this.h = hooks;
    this.reset();
    this.charge = 0;
    this.charging = false;
    // 双击记录必须活过 reset()：reset 在每次按下时调用，
    // 若把它清掉，第二次点击就永远读不到第一次的记录。
    this.lastTapTime = 0;
    this.lastTapX = 0;
    this.lastTapY = 0;
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
    this.navFollow = false;   // 导航中是否已切到「手指列跟随」
    this.navBaseCol = 0;      // 进入导航时的方块列（= 正下方起点），滑动 = 相对手指按下点的位移
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
        // 用方块实际中心列做导航起点，不依赖触点落在哪一格。
        // 否则宽方块（I/O）按在不同格子上会差 1~3 列，用户感觉「偏方向」。
        self.navFollow = false;   // 不动时保持中心列，滑动后才切到手指列
        self.navCol = self.navBaseCol = self.h.getPieceCol ? self.h.getPieceCol() : self.colAt(self.lastX);
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

  Gesture.prototype.colAt = function (x, useGrab) {
    if (useGrab === undefined) useGrab = true;
    var cell = this.h.getCell();
    var origin = this.h.getOrigin();
    var off = useGrab ? this.grabOffset : 0;   // 导航滑动时忽略抓取偏移，落点直接对齐手指所在列
    return Math.round((x - origin.x) / cell - off);
  };

  /* 判定旋转方向：以方块中心轴线把屏幕切成左右两半。
   *
   *   左半区上滑 → 顺时针(+1)    右半区上滑 → 逆时针(-1)
   *
   * 这是「推转盘」的物理直觉：在左侧往上推，盘子顺时针转。
   * 相比旧的滑动角度判定（dx/ady），落点是玩家按下手指那一刻就确定的，
   * 不会因滑动过程中的手指漂移而翻转，方向可预测得多。
   *
   * 拿不到轴线时（方块已锁定等）退回旧的斜滑角度判定。
   */
  Gesture.prototype.rotDirAt = function (x, dx, ady) {
    var axis = this.h.getPieceCenterX ? this.h.getPieceCenterX() : null;
    if (axis == null) {
      return (dx / ady) < -P.ROT_BIAS_SLOPE ? -1 : 1;
    }
    return x < axis ? 1 : -1;
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
          this.navFollow = false;
          this.navCol = this.navBaseCol = this.h.getPieceCol ? this.h.getPieceCol() : this.colAt(x);
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
        this.rotDir = this.rotDirAt(this.startX, dx, ady);
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
      // 不动时保持方块中心列（正下方，不左偏不右偏）；
      // 手指滑动后，落点 = 起点方块列 + 相对手指按下点的位移，1:1 跟手且左右完全对称。
      // 用相对位移而非「手指绝对列」，可消除 grabOffset 造成的进入瞬间右跳、左滑需多补偿行程的不对称感。
      var cell = this.h.getCell();
      if (!this.navFollow) {
        var dx0 = x - this.startX, dy0 = y - this.startY;
        if (Math.abs(dx0) < cell * P.NAV_FOLLOW_MIN &&
            Math.abs(dy0) < cell * P.NAV_FOLLOW_MIN) {
          return;   // 手指基本没动，维持中心列
        }
        this.navFollow = true;
      }
      var col = this.navBaseCol + Math.round((x - this.startX) / cell);
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
      if (this.onPiece) {
        // 轻点方块 = 快速顺时针旋转（单击即生效，无需等双击判定）
        this.h.onTapPiece();
        this.lastTapTime = 0;                 // 方块上的点击不参与空白双击计数
      } else {
        // 空白处：单击不做事，双击才旋转。
        // 这样既保留了「误触空白无副作用」，又给了不用瞄准方块的旋转入口。
        var gap = t - this.lastTapTime;
        var near = Math.abs(this.startX - this.lastTapX) + Math.abs(this.startY - this.lastTapY);
        if (this.lastTapTime && gap < P.DTAP_MS && near < P.DTAP_DIST) {
          // 双击旋转：不区分屏幕左右半区，一律顺时针(+1)，简化记忆
          this.h.onDoubleTap ? this.h.onDoubleTap(1) : this.h.onRotate(1);
          this.lastTapTime = 0;               // 立即清零，防止三击被判成两组双击
        } else {
          this.lastTapTime = t;
          this.lastTapX = this.startX;
          this.lastTapY = this.startY;
        }
      }
    } else {
      // 发生了滑动/长按等实质操作，中断双击链，避免与下一次轻点意外配对
      this.lastTapTime = 0;
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
