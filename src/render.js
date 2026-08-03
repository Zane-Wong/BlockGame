/* render.js - Canvas 渲染层
 * 所有绘制使用逻辑像素（CSS px），DPR 缩放由主程序统一处理。
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

  /* 蓄力弹弓：皮筋 + 力度轨迹 */
  Renderer.prototype.slingshot = function (piece, power, buffer, dropY) {
    var ctx = this.ctx, L = this.L;
    var cells = piece.cells();
    var minX = 99, maxX = -99, minY = 99, maxY = -99;
    for (var i = 0; i < cells.length; i++) {
      minX = Math.min(minX, cells[i][0]); maxX = Math.max(maxX, cells[i][0]);
      minY = Math.min(minY, cells[i][1]); maxY = Math.max(maxY, cells[i][1]);
    }
    var cx = L.x + (minX + maxX + 1) / 2 * L.cell;
    var topY = L.y + (minY - buffer) * L.cell;
    var botY = L.y + (maxY + 1 - buffer) * L.cell;
    var pull = power * L.cell * 1.5;

    // 皮筋：从棋盘顶部两侧拉向方块
    var anchorY = L.y + 2;
    ctx.strokeStyle = rgba(piece.color, 0.35 + 0.5 * power);
    ctx.lineWidth = 1.5 + 2.5 * power;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(L.x + 6, anchorY);
    ctx.lineTo(cx, topY - 2 + pull * 0.15);
    ctx.lineTo(L.x + L.cols * L.cell - 6, anchorY);
    ctx.stroke();

    // 发射轨迹
    var targetY = L.y + (dropY + (maxY - minY) + 1 - buffer) * L.cell;
    var grad = ctx.createLinearGradient(cx, botY, cx, targetY);
    grad.addColorStop(0, rgba(piece.color, 0.55 * (0.3 + power)));
    grad.addColorStop(1, rgba(piece.color, 0));
    ctx.fillStyle = grad;
    var halfW = L.cell * (0.18 + 0.30 * power);
    ctx.fillRect(cx - halfW, botY, halfW * 2, Math.max(0, targetY - botY));

    // 力度环
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(cx, topY - L.cell * 0.55, L.cell * 0.34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * power);
    ctx.strokeStyle = power > 0.85 ? '#ffd84d' : piece.color;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (power > 0.98) {
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = '#ffd84d';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('MAX', cx, topY - L.cell * 0.55 + 4);
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
    var cell = Math.min(w / (bw + 0.6), h / (bh + 0.6));
    var ox = (w - bw * cell) / 2 - minX * cell;
    var oy = (h - bh * cell) / 2 - minY * cell;
    var color = TZ.COLORS[type];
    for (var j = 0; j < shape.length; j++) {
      var x = ox + shape[j][0] * cell + 1;
      var y = oy + shape[j][1] * cell + 1;
      var s = cell - 2;
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
