/*!
 * ============================================================================
 *  魔方坠落 · 手势俄罗斯方块  (Gesture Tetris)
 * ----------------------------------------------------------------------------
 *  @file         src/fx.js
 *  @description  粒子、震屏、浮字与合成音效
 *  @author       wangzhuo <mail_zhuo@163.com>
 *  @contact      mail_zhuo@163.com
 *  @copyright    Copyright (c) 2026 wangzhuo. All rights reserved.
 *  @license      本项目为 wangzhuo 原创作品，受著作权法保护。
 *                未经作者书面许可，不得复制、修改、分发或用于任何商业用途。
 * ============================================================================
 *
 *  fx.js - 粒子、震屏、浮字与合成音效
 *  音效全部由 WebAudio 实时合成，不依赖任何外部资源文件。
 */
(function (global) {
  'use strict';
  var TZ = global.TZ || (global.TZ = {});

  /* ---------- 音效 ---------- */
  function Audio() {
    this.ctx = null;
    this.enabled = true;
    this.master = null;
  }

  Audio.prototype.ensure = function () {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.28;
      this.master.connect(this.ctx.destination);
      return true;
    } catch (e) { return false; }
  };

  /* 基础音：一段带包络的振荡器 */
  Audio.prototype.tone = function (opt) {
    if (!this.enabled || !this.ensure()) return;
    var ctx = this.ctx;
    var t0 = ctx.currentTime;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = opt.type || 'square';
    osc.frequency.setValueAtTime(opt.from, t0);
    if (opt.to && opt.to !== opt.from) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opt.to), t0 + opt.dur);
    }
    var vol = opt.vol == null ? 0.3 : opt.vol;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + opt.dur);
    osc.connect(gain); gain.connect(this.master);
    osc.start(t0); osc.stop(t0 + opt.dur + 0.02);
  };

  /* 噪声脉冲，用于撞击与碎裂 */
  Audio.prototype.noise = function (dur, vol, freq) {
    if (!this.enabled || !this.ensure()) return;
    var ctx = this.ctx;
    var len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq || 1200;
    var gain = ctx.createGain();
    gain.gain.value = vol == null ? 0.25 : vol;
    src.connect(filter); filter.connect(gain); gain.connect(this.master);
    src.start();
  };

  Audio.prototype.move = function () { this.tone({ from: 320, to: 300, dur: 0.04, vol: 0.12, type: 'square' }); };
  Audio.prototype.rotate = function () { this.tone({ from: 480, to: 660, dur: 0.07, vol: 0.16, type: 'triangle' }); };
  Audio.prototype.lock = function () { this.noise(0.09, 0.18, 900); this.tone({ from: 180, to: 90, dur: 0.1, vol: 0.2, type: 'sine' }); };
  Audio.prototype.charge = function () { this.tone({ from: 200, to: 240, dur: 0.09, vol: 0.06, type: 'sine' }); };
  Audio.prototype.launch = function (power) {
    var p = power || 1;
    this.tone({ from: 700 + 500 * p, to: 120, dur: 0.16 + 0.1 * p, vol: 0.22, type: 'sawtooth' });
    this.noise(0.12, 0.16 * p, 600);
  };
  Audio.prototype.navigate = function () { this.tone({ from: 520, to: 780, dur: 0.1, vol: 0.14, type: 'sine' }); };
  Audio.prototype.clear = function (n) {
    var base = [0, 523, 587, 659, 784][n] || 523;
    var self = this;
    for (var i = 0; i < n; i++) {
      (function (i) {
        setTimeout(function () {
          self.tone({ from: base * Math.pow(1.18, i), to: base * Math.pow(1.18, i) * 1.5, dur: 0.16, vol: 0.24, type: 'triangle' });
        }, i * 55);
      })(i);
    }
    this.noise(0.18, 0.12 + 0.05 * n, 2000);
  };
  Audio.prototype.over = function () {
    var self = this;
    [440, 370, 294, 220].forEach(function (f, i) {
      setTimeout(function () { self.tone({ from: f, to: f * 0.94, dur: 0.28, vol: 0.22, type: 'triangle' }); }, i * 150);
    });
  };

  /* 联机：我发动攻击（消行即攻击下一对手）—— 锐利发射感 */
  Audio.prototype.attack = function (n) {
    var self = this;
    var lines = n || 1;
    this.tone({ from: 520, to: 1320, dur: 0.07, vol: 0.18, type: 'square' });
    setTimeout(function () { self.noise(0.1, 0.16, 900); }, 55);
    setTimeout(function () { self.tone({ from: 220 + lines * 50, to: 80, dur: 0.15, vol: 0.22, type: 'sawtooth' }); }, 70);
  };

  /* 联机：我被攻击 —— 低沉受击感 */
  Audio.prototype.hurt = function (n) {
    var lines = n || 1;
    this.tone({ from: 180 - lines * 12, to: 55, dur: 0.24, vol: 0.26, type: 'sawtooth' });
    this.noise(0.22, 0.14 + 0.04 * lines, 360);
  };

  /* ---------- 粒子 ---------- */
  function Particles() { this.list = []; }

  Particles.prototype.burst = function (x, y, color, count, opt) {
    opt = opt || {};
    var spread = opt.spread == null ? Math.PI * 2 : opt.spread;
    var dir = opt.dir == null ? 0 : opt.dir;
    var speed = opt.speed == null ? 2.6 : opt.speed;
    for (var i = 0; i < count; i++) {
      var a = dir + (Math.random() - 0.5) * spread;
      var s = speed * (0.4 + Math.random() * 0.9);
      this.list.push({
        x: x, y: y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - (opt.lift || 0),
        life: 1,
        decay: 0.012 + Math.random() * 0.022,
        size: (opt.size || 3) * (0.5 + Math.random()),
        color: color,
        gravity: opt.gravity == null ? 0.12 : opt.gravity
      });
    }
  };

  Particles.prototype.update = function () {
    for (var i = this.list.length - 1; i >= 0; i--) {
      var p = this.list[i];
      p.x += p.vx; p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= 0.99;
      p.life -= p.decay;
      if (p.life <= 0) this.list.splice(i, 1);
    }
  };

  Particles.prototype.draw = function (ctx) {
    for (var i = 0; i < this.list.length; i++) {
      var p = this.list[i];
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      var s = p.size * p.life;
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  };

  Particles.prototype.clear = function () { this.list.length = 0; };

  /* ---------- 震屏 ---------- */
  function Shake() { this.amount = 0; this.x = 0; this.y = 0; }
  Shake.prototype.add = function (v) { this.amount = Math.min(24, this.amount + v); };
  Shake.prototype.update = function () {
    if (this.amount > 0.1) {
      this.x = (Math.random() - 0.5) * this.amount;
      this.y = (Math.random() - 0.5) * this.amount;
      this.amount *= 0.86;
    } else { this.amount = 0; this.x = 0; this.y = 0; }
  };

  /* ---------- 浮动文字 ---------- */
  function Floaters() { this.list = []; }
  Floaters.prototype.add = function (x, y, text, color, size) {
    this.list.push({ x: x, y: y, text: text, color: color || '#fff', life: 1, size: size || 20, vy: -0.9 });
  };
  Floaters.prototype.update = function () {
    for (var i = this.list.length - 1; i >= 0; i--) {
      var f = this.list[i];
      f.y += f.vy; f.vy *= 0.96; f.life -= 0.016;
      if (f.life <= 0) this.list.splice(i, 1);
    }
  };
  Floaters.prototype.draw = function (ctx) {
    for (var i = 0; i < this.list.length; i++) {
      var f = this.list[i];
      ctx.globalAlpha = Math.max(0, Math.min(1, f.life * 1.6));
      ctx.fillStyle = f.color;
      ctx.font = '600 ' + f.size + 'px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  };
  Floaters.prototype.clear = function () { this.list.length = 0; };

  TZ.Audio = Audio;
  TZ.Particles = Particles;
  TZ.Shake = Shake;
  TZ.Floaters = Floaters;

})(typeof window !== 'undefined' ? window : this);

/* @author wangzhuo <mail_zhuo@163.com> - 魔方坠落 Gesture Tetris | 版权所有，翻版必究 */
