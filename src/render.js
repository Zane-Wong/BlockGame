/*!
 * ============================================================================
 *  魔方坠落 · 手势俄罗斯方块  (Gesture Tetris)
 * ----------------------------------------------------------------------------
 *  @file         src/render.js
 *  @description  Canvas 渲染层：棋盘、方块、幽灵、导航指示与蓄力弹弓
 *  @author       wangzhuo <mail_zhuo@163.com>
 *  @contact      mail_zhuo@163.com
 *  @copyright    Copyright (c) 2026 wangzhuo. All rights reserved.
 *  @license      本项目为 wangzhuo 原创作品，受著作权法保护。
 *                未经作者书面许可，不得复制、修改、分发或用于任何商业用途。
 * ============================================================================
 *
 *  render.js - Canvas 渲染层
 *  所有绘制使用逻辑像素（CSS px），DPR 缩放由主程序统一处理。
 */
(function (global) {
  'use strict';
  var TZ = global.TZ || (global.TZ = {});

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgba(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }
  function shade(hex, amt) {
    var c = hexToRgb(hex);
    function f(v) { return Math.max(0, Math.min(255, Math.round(v + amt))); }
    return 'rgb(' + f(c.r) + ',' + f(c.g) + ',' + f(c.b) + ')';
  }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function Renderer(ctx, layout) {
    this.ctx = ctx;
    this.L = layout;   // {x, y, cell, cols, rows, w, h}
  }

  Renderer.prototype.setLayout = function (L) { this.L = L; };

  Renderer.prototype.cellRect = function (gx, gy) {
    var L = this.L;
    return {
      x: L.x + gx * L.cell,
      y: L.y + gy * L.cell,
      s: L.cell
    };
  };

  /* 单个方块格子 */
  Renderer.prototype.block = function (gx, gy, color, opt) {
    opt = opt || {};
    var ctx = this.ctx;
    var r = this.cellRect(gx, gy);
    var pad = opt.pad == null ? 1.5 : opt.pad;
    var x = r.x + pad, y = r.y + pad, s = r.s - pad * 2;
    var alpha = opt.alpha == null ? 1 : opt.alpha;

    ctx.globalAlpha = alpha;
    roundRect(ctx, x, y, s, s, s * 0.18);
    ctx.fillStyle = color;
    ctx.fill();

    // 顶部高光
    ctx.globalAlpha = alpha * 0.5;
    roundRect(ctx, x + s * 0.12, y + s * 0.1, s * 0.76, s * 0.28, s * 0.1);
    ctx.fillStyle = shade(color, 62);
    ctx.fill();

    // 底部暗边
    ctx.globalAlpha = alpha * 0.35;
    roundRect(ctx, x + s * 0.1, y + s * 0.66, s * 0.8, s * 0.24, s * 0.1);
    ctx.fillStyle = shade(color, -58);
    ctx.fill();

    if (opt.glow) {
      ctx.globalAlpha = alpha * opt.glow;
      roundRect(ctx, x - 1, y - 1, s + 2, s + 2, s * 0.2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  /* 空心轮廓格（幽灵 / 导航目标） */
  Renderer.prototype.outline = function (gx, gy, color, opt) {
    opt = opt || {};
    var ctx = this.ctx;
    var r = this.cellRect(gx, gy);
    var pad = 2;
    var x = r.x + pad, y = r.y + pad, s = r.s - pad * 2;
    ctx.globalAlpha = opt.fill == null ? 0.14 : opt.fill;
    roundRect(ctx, x, y, s, s, s * 0.18);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = opt.stroke == null ? 0.7 : opt.stroke;
    ctx.strokeStyle = color;
    ctx.lineWidth = opt.lw || 1.6;
    if (opt.dash) ctx.setLineDash(opt.dash);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  };

  /* 棋盘背景与网格 */
  Renderer.prototype.field = function () {
    var ctx = this.ctx, L = this.L;
    var w = L.cols * L.cell, h = L.rows * L.cell;

    roundRect(ctx, L.x - 4, L.y - 4, w + 8, h + 8, 12);
    ctx.fillStyle = 'rgba(12,14,26,0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var c = 1; c < L.cols; c++) {
      var gx = Math.round(L.x + c * L.cell) + 0.5;
      ctx.moveTo(gx, L.y); ctx.lineTo(gx, L.y + h);
    }
    for (var rI = 1; rI < L.rows; rI++) {
      var gy = Math.round(L.y + rI * L.cell) + 0.5;
      ctx.moveTo(L.x, gy); ctx.lineTo(L.x + w, gy);
    }
    ctx.stroke();
  };

  /* 已固化的砖块 */
  Renderer.prototype.stack = function (board, flashRows, flashT) {
    var buffer = board.buffer;
    for (var y = buffer; y < board.total; y++) {
      var gy = y - buffer;
      var isFlash = flashRows && flashRows.indexOf(y) >= 0;
      for (var x = 0; x < board.cols; x++) {
        var c = board.grid[y][x];
        if (!c) continue;
        if (isFlash) {
          var k = 1 - flashT;
          this.block(x, gy, '#ffffff', { alpha: 0.35 + 0.65 * k, glow: k });
        } else {
          this.block(x, gy, c.color);
        }
      }
    }
  };

  /* 活动方块 */
  Renderer.prototype.piece = function (piece, buffer, opt) {
    opt = opt || {};
    var cells = piece.cells();
    for (var i = 0; i < cells.length; i++) {
      var gy = cells[i][1] - buffer;
      if (gy < 0) continue;
      this.block(cells[i][0], gy, piece.color, opt);
    }
  };

  /* 幽灵落点 */
  Renderer.prototype.ghost = function (piece, dropY, buffer) {
    var cells = piece.cells(piece.rot, piece.x, dropY);
    for (var i = 0; i < cells.length; i++) {
      var gy = cells[i][1] - buffer;
      if (gy < 0) continue;
      this.outline(cells[i][0], gy, piece.color, { fill: 0.10, stroke: 0.42, lw: 1.4 });
    }
  };

  /* 导航模式：目标轮廓 + 引导线 + 列高亮 */
  Renderer.prototype.navigation = function (piece, targetX, targetRot, targetY, buffer, t) {
    var ctx = this.ctx, L = this.L;
    var pulse = 0.5 + 0.5 * Math.sin(t / 160);

    // 目标列高亮
    var tmp = piece.clone(); tmp.rot = targetRot;
    var cols = {};
    var cellsT = tmp.cells(targetRot, targetX, targetY);
    for (var i = 0; i < cellsT.length; i++) cols[cellsT[i][0]] = true;
    ctx.globalAlpha = 0.06 + 0.05 * pulse;
    ctx.fillStyle = piece.color;
    for (var k in cols) {
      if (!cols.hasOwnProperty(k)) continue;
      var cx = L.x + parseInt(k, 10) * L.cell;
      ctx.fillRect(cx, L.y, L.cell, L.rows * L.cell);
    }
    ctx.globalAlpha = 1;

    // 目标位置轮廓
    for (var j = 0; j < cellsT.length; j++) {
      var gy = cellsT[j][1] - buffer;
      if (gy < 0) continue;
      this.outline(cellsT[j][0], gy, piece.color, {
        fill: 0.20 + 0.10 * pulse,
        stroke: 0.85,
        lw: 2,
        dash: [5, 4]
      });
    }

    // 从当前位置到目标的引导曲线
    var src = piece.cells();
    var sx = 0, sy = 0;
    for (var a = 0; a < src.length; a++) { sx += src[a][0]; sy += src[a][1]; }
    sx = L.x + (sx / src.length + 0.5) * L.cell;
    sy = L.y + (sy / src.length + 0.5 - buffer) * L.cell;
    var dx = 0, dy = 0;
    for (var b = 0; b < cellsT.length; b++) { dx += cellsT[b][0]; dy += cellsT[b][1]; }
    dx = L.x + (dx / cellsT.length + 0.5) * L.cell;
    dy = L.y + (dy / cellsT.length + 0.5 - buffer) * L.cell;

    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = piece.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.lineDashOffset = -(t / 26) % 12;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo((sx + dx) / 2, sy + (dy - sy) * 0.28, dx, dy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // 目标端点圆环
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(dx, dy, 5 + 2 * pulse, 0, Math.PI * 2);
    ctx.strokeStyle = piece.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  /* 蓄力弹弓
   * 皮筋兜住方块顶边，两端锚点固定在左右墙上、且始终低于方块最低一格。
   * 锚点位置在蓄力开始时就确定，蓄力期间不变；只有绳身张力和颜色随力度变化。
   * 注意：需在方块之后绘制，绳子才会覆盖在方块上。
   */
  Renderer.prototype.slingshot = function (piece, power, buffer, dropY) {
    var ctx = this.ctx, L = this.L, cell = L.cell, i;
    var cells = piece.cells();
    var minX = 99, maxX = -99, minY = 99, maxY = -99;
    for (i = 0; i < cells.length; i++) {
      minX = Math.min(minX, cells[i][0]); maxX = Math.max(maxX, cells[i][0]);
      minY = Math.min(minY, cells[i][1]); maxY = Math.max(maxY, cells[i][1]);
    }
    // 顶行的真实跨度：皮筋兜在最高那几格上，而不是包围盒（S/Z/T/L/J 差别明显）
    var tMinX = 99, tMaxX = -99;
    for (i = 0; i < cells.length; i++) {
      if (cells[i][1] === minY) {
        tMinX = Math.min(tMinX, cells[i][0]); tMaxX = Math.max(tMaxX, cells[i][0]);
      }
    }

    var cx = L.x + (minX + maxX + 1) / 2 * cell;
    var topY = L.y + (minY - buffer) * cell;
    var botY = L.y + (maxY + 1 - buffer) * cell;
    var boardL = L.x, boardR = L.x + L.cols * cell, boardB = L.y + L.rows * cell;
    var slack = 1 - power;

    // ── 锚点：固定不动，低于方块最低一格约一格半的位置 ──
    var ax0 = boardL + cell * 0.14, ax1 = boardR - cell * 0.14;
    var anchorY = botY + cell * 1.5;
    if (anchorY > boardB - cell * 0.3) anchorY = boardB - cell * 0.3;

    // 兜带：压在方块顶边上，蓄力越满压得越平
    var pouchY = topY + cell * 0.09;
    var pouchL = L.x + tMinX * cell;
    var pouchR = L.x + (tMaxX + 1) * cell;
    var pouchMid = (pouchL + pouchR) / 2;

    var col = power > 0.85 ? '#ffd84d' : piece.color;
    // 弓度：松弛时下垂明显，绷紧时趋近直线；全程由 slack 控制
    var bow = cell * (0.12 + 0.75 * slack);
    var m1x = (ax0 + pouchL) / 2, m1y = (anchorY + pouchY) / 2;
    var m2x = (ax1 + pouchR) / 2, m2y = (anchorY + pouchY) / 2;

    function bandPath() {
      ctx.beginPath();
      ctx.moveTo(ax0, anchorY);
      ctx.quadraticCurveTo(m1x - bow * 0.32, m1y + bow, pouchL, pouchY);
      ctx.quadraticCurveTo(pouchMid, pouchY - cell * 0.24 * slack, pouchR, pouchY);
      ctx.quadraticCurveTo(m2x + bow * 0.32, m2y + bow, ax1, anchorY);
      ctx.stroke();
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 三层线：粗底色 + 细主色 + 高光芯。颜色从虚到显但最终不刺眼
    var lw = cell * (0.15 - 0.04 * power);        // 拉伸越紧绳身越细
    ctx.strokeStyle = rgba(col, 0.10 + 0.18 * power);
    ctx.lineWidth = lw + cell * 0.20;
    bandPath();
    ctx.strokeStyle = rgba(col, 0.42 + 0.35 * power);
    ctx.lineWidth = lw;
    bandPath();
    ctx.strokeStyle = rgba('#ffffff', 0.08 + 0.18 * power);
    ctx.lineWidth = Math.max(0.7, lw * 0.26);
    bandPath();

    // 墙上的锚桩（大小和颜色也固定，不随力度变化）
    for (i = 0; i < 2; i++) {
      var px = i ? ax1 : ax0;
      ctx.beginPath();
      ctx.arc(px, anchorY, cell * 0.22, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(col, 0.30);
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, anchorY, cell * 0.11, 0, Math.PI * 2);
      ctx.fillStyle = rgba(col, 0.65);
      ctx.fill();
    }
    ctx.restore();

    /* ── 发射轨迹光柱 ──────────────────────────────────────────────
     * 等宽矩形光带（不外扩），上下两端不透明度都归零：
     *   上边界紧贴方块底边，若在此保留实色会出现一条硬接缝（违和感来源），
     *   淡出后光柱像是从方块内部渗出来的；
     *   下边界同样淡出，避免在落点处被生硬截断。
     * 亮度峰值落在中段，形成一条有呼吸感的光带；宽度只随蓄力强度整体变化。
     */
    var targetY = L.y + (dropY + (maxY - minY) + 1 - buffer) * cell;
    var beamH = targetY - botY;
    if (beamH > cell * 0.3) {
      var peak = 0.15 + 0.33 * power;            // 中段最亮处的不透明度
      var wBeam = cell * (0.16 + 0.24 * power);  // 半宽，上下等宽

      var grad = ctx.createLinearGradient(cx, botY, cx, targetY);
      grad.addColorStop(0.00, rgba(piece.color, 0));           // 上边界全透明
      grad.addColorStop(0.18, rgba(piece.color, peak * 0.72));
      grad.addColorStop(0.46, rgba(piece.color, peak));        // 中段最实
      grad.addColorStop(0.78, rgba(piece.color, peak * 0.40));
      grad.addColorStop(1.00, rgba(piece.color, 0));           // 下边界全透明
      ctx.fillStyle = grad;
      ctx.fillRect(cx - wBeam, botY, wBeam * 2, beamH);

      // 芯线：更窄的一道白光，同样两端淡出，强化「柱」的纵深
      var core = ctx.createLinearGradient(cx, botY, cx, targetY);
      core.addColorStop(0.00, rgba('#ffffff', 0));
      core.addColorStop(0.42, rgba('#ffffff', 0.04 + 0.12 * power));
      core.addColorStop(1.00, rgba('#ffffff', 0));
      ctx.fillStyle = core;
      ctx.fillRect(cx - wBeam * 0.38, botY, wBeam * 0.76, beamH);

      // 加速指示：下行箭头，用 sin 包络让首尾也淡下去，与光柱同步
      if (beamH > cell * 1.6) {
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 2;
        for (i = 1; i <= 3; i++) {
          var t = i / 4;
          var ay = botY + beamH * t;
          var aw = cell * (0.18 + 0.16 * power);
          var env = Math.sin(Math.PI * t) * (1 - t * 0.35);
          ctx.strokeStyle = rgba(col, (0.10 + 0.55 * power) * env);
          ctx.beginPath();
          ctx.moveTo(cx - aw, ay - aw * 0.55);
          ctx.lineTo(cx, ay + aw * 0.4);
          ctx.lineTo(cx + aw, ay - aw * 0.55);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 力度环（贴在方块上方，靠近顶部时自动下移避免出界）
    var ringY = Math.max(L.y + cell * 0.5, topY - cell * 0.62);
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(cx, ringY, cell * 0.34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * power);
    ctx.strokeStyle = col;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (power > 0.98) {
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = '#ffd84d';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('MAX', cx, ringY + 4);
      ctx.globalAlpha = 1;
    }
  };

  /* next 队列小预览 */
  Renderer.drawMini = function (ctx, type, w, h) {
    ctx.clearRect(0, 0, w, h);
    var shape = TZ.SHAPES[type][0];
    var minX = 9, maxX = -9, minY = 9, maxY = -9;
    for (var i = 0; i < shape.length; i++) {
      minX = Math.min(minX, shape[i][0]); maxX = Math.max(maxX, shape[i][0]);
      minY = Math.min(minY, shape[i][1]); maxY = Math.max(maxY, shape[i][1]);
    }
    var bw = maxX - minX + 1, bh = maxY - minY + 1;
    // 用整数格边距保证像素对齐，避免亚像素偏移导致视觉偏移
    var pad = Math.max(2, Math.round(Math.min(w, h) * 0.10));
    var cell = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
    // 居中：让包围盒几何中心与画布中心对齐
    var ox = (w - bw * cell) / 2 - minX * cell;
    var oy = (h - bh * cell) / 2 - minY * cell;
    var color = TZ.COLORS[type];
    for (var j = 0; j < shape.length; j++) {
      var x = Math.round(ox + shape[j][0] * cell);
      var y = Math.round(oy + shape[j][1] * cell);
      var s = Math.round(cell - 2);
      roundRect(ctx, x, y, s, s, s * 0.2);
      ctx.fillStyle = color; ctx.fill();
      ctx.globalAlpha = 0.45;
      roundRect(ctx, x + s * 0.12, y + s * 0.1, s * 0.76, s * 0.26, s * 0.1);
      ctx.fillStyle = shade(color, 60); ctx.fill();
      ctx.globalAlpha = 1;
    }
  };

  Renderer.roundRect = roundRect;
  Renderer.rgba = rgba;
  Renderer.shade = shade;
  TZ.Renderer = Renderer;

})(typeof window !== 'undefined' ? window : this);

/* @author wangzhuo <mail_zhuo@163.com> - 魔方坠落 Gesture Tetris | 版权所有，翻版必究 */
