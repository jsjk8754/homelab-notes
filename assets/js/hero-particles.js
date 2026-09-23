const TAU = Math.PI * 2;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function seededRandom(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/**
 * A self-contained, local-coordinate particle title for the homepage hero.
 * The fallback title remains visible until the first canvas frame is drawn.
 */
export class HeroParticles {
  constructor(canvas, { title = 'Alcedo', fontFamily = 'Instrument' } = {}) {
    if (!canvas?.getContext) throw new TypeError('HeroParticles requires a canvas element.');

    this.canvas = canvas;
    this.stage = canvas.closest('.hero-stage') || canvas.parentElement;
    if (!this.stage) throw new Error('HeroParticles requires a parent stage.');

    this.title = title;
    this.fontFamily = fontFamily;
    this.theme = this._themeFromDom();
    this.pointer = { x: -10_000, y: -10_000, active: false };
    this.waves = [];
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.count = 0;
    this.ambientCount = 0;
    this.fps = 0;
    this.frames = 0;
    this.elapsed = 0;
    this.time = 0;
    this.lastFrame = performance.now();
    this.lastRipple = 0;
    this.raf = 0;
    this.wantsToRun = false;
    this.dirty = true;
    this.settledFrames = 0;
    this.inView = true;
    this.contextLost = false;
    this.destroyed = false;
    this.ready = false;
    this.renderer = 'static';

    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduced = this.motionQuery.matches;

    this._frame = this._frame.bind(this);
    this._handleVisibility = this._handleVisibility.bind(this);
    this._handlePointerMove = this._handlePointerMove.bind(this);
    this._handlePointerLeave = this._handlePointerLeave.bind(this);
    this._handlePointerDown = this._handlePointerDown.bind(this);
    this._handleContextLost = this._handleContextLost.bind(this);
    this._handleContextRestored = this._handleContextRestored.bind(this);
    this._handleMotionChange = event => this.setReducedMotion(event.matches);

    this._setupRenderer();
    this._bindObservers();
    this.resize();
    this.setTheme(this.theme);
    this._loadFont();
  }

  get metrics() {
    return {
      renderer: this.renderer,
      count: this.count,
      fps: this.fps,
      running: Boolean(this.raf),
      reduced: this.reduced,
    };
  }

  start() {
    if (this.destroyed) return this;
    this.wantsToRun = true;
    this.lastFrame = performance.now();
    if (this.reduced) {
      this._settle(true);
      this.dirty = false;
      this._draw();
    } else {
      this._markDirty();
    }
    return this;
  }

  pause() {
    this.wantsToRun = false;
    this._cancelFrame();
    return this;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.wantsToRun = false;
    this._cancelFrame();

    document.removeEventListener('visibilitychange', this._handleVisibility);
    this.canvas.removeEventListener('pointermove', this._handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this._handlePointerLeave);
    this.canvas.removeEventListener('pointercancel', this._handlePointerLeave);
    this.canvas.removeEventListener('pointerdown', this._handlePointerDown);
    this.canvas.removeEventListener('webglcontextlost', this._handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this._handleContextRestored);
    this.motionQuery.removeEventListener?.('change', this._handleMotionChange);
    this.motionQuery.removeListener?.(this._handleMotionChange);
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.themeObservers?.forEach(observer => observer.disconnect());
    if (this._windowResize) window.removeEventListener('resize', this._windowResize);

    if (this.gl) {
      if (this.vertexBuffer) this.gl.deleteBuffer(this.vertexBuffer);
      if (this.program) this.gl.deleteProgram(this.program);
    }

    this.stage.classList.remove('is-ready');
    this.positions = null;
    this.velocities = null;
    this.targets = null;
    this.seed = null;
    this.buffer = null;
  }

  resize() {
    if (this.destroyed) return this;
    const rect = this.canvas.getBoundingClientRect();
    const stageRect = this.stage.getBoundingClientRect();
    const width = Math.max(1, rect.width || stageRect.width);
    const height = Math.max(1, rect.height || stageRect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    const sizeChanged = width !== this.width || height !== this.height || dpr !== this.dpr;

    this.width = width;
    this.height = height;
    this.dpr = dpr;
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;

    if (this.gl && !this.contextLost) {
      this.gl.viewport(0, 0, pixelWidth, pixelHeight);
      this.gl.useProgram(this.program);
      this.gl.uniform2f(this.uniforms.resolution, width, height);
      this.gl.uniform1f(this.uniforms.ratio, dpr);
    } else if (this.ctx) {
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const desiredCount = this.renderer === 'webgl'
      ? (width <= 700 ? 4500 : 13000)
      : Math.min(1800, width <= 700 ? 1200 : 1800);

    if (sizeChanged || desiredCount !== this.count || !this.targets) {
      this._buildParticles(desiredCount);
      this._makeTitleTargets();
      this._settle(true);
    }

    this._requestRender();
    return this;
  }

  setTheme(theme = 'ink') {
    this.theme = theme === 'paper' ? 'paper' : 'ink';
    this._applyThemeUniforms();
    this._requestRender();
    return this;
  }

  burst(x = this.pointer.active ? this.pointer.x : this.width / 2, y = this.pointer.active ? this.pointer.y : this.height / 2) {
    if (this.destroyed || !this.positions) return this;
    this._addWave(x, y, 2.4);

    if (this.reduced) {
      this._applyReducedPointer(x, y, 13);
      this._draw();
      return this;
    }

    for (let i = 0; i < this.count; i += 1) {
      const p = i * 2;
      const dx = this.positions[p] - x;
      const dy = this.positions[p + 1] - y;
      const distance = Math.hypot(dx, dy) || 1;
      const angle = this.seed[i * 4] * TAU;
      const force = 10 + this.seed[i * 4 + 1] * 34;
      this.velocities[p] += (dx / distance) * force + Math.cos(angle) * 6;
      this.velocities[p + 1] += (dy / distance) * force + Math.sin(angle) * 6;
    }
    this._markDirty();
    return this;
  }

  setReducedMotion(value) {
    const next = Boolean(value);
    if (next === this.reduced) return this;
    this.reduced = next;
    this._cancelFrame();
    this.waves.length = 0;
    this.pointer.active = false;
    this._settle(true);
    this.dirty = false;
    this.settledFrames = 0;
    this._draw();
    if (!next) {
      this._markDirty();
    }
    return this;
  }

  _setupRenderer() {
    this.canvas.addEventListener('webglcontextlost', this._handleContextLost);
    this.canvas.addEventListener('webglcontextrestored', this._handleContextRestored);

    let gl;
    try {
      gl = this.canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      gl = null;
    }

    if (gl) {
      try {
        this.gl = gl;
        this._createWebGLResources();
        this.renderer = 'webgl';
        return;
      } catch (error) {
        console.warn('Hero particle WebGL setup failed; the text fallback remains visible.', error);
        this.gl = null;
      }
    }

    try {
      this.ctx = this.canvas.getContext('2d', { alpha: true });
    } catch {
      this.ctx = null;
    }
    this.renderer = this.ctx ? 'canvas' : 'static';
  }

  _createWebGLResources() {
    const gl = this.gl;
    const vertexSource = `
      attribute vec2 position;
      attribute float size;
      attribute float alpha;
      attribute float warm;
      uniform vec2 resolution;
      uniform float ratio;
      uniform vec3 baseColor;
      uniform vec3 accentColor;
      varying vec4 tint;
      void main() {
        vec2 point = position / resolution;
        gl_Position = vec4(point.x * 2.0 - 1.0, 1.0 - point.y * 2.0, 0.0, 1.0);
        gl_PointSize = size * ratio;
        tint = vec4(mix(baseColor, accentColor, warm), alpha);
      }
    `;
    const fragmentSource = `
      precision mediump float;
      varying vec4 tint;
      void main() {
        float distanceFromCenter = length(gl_PointCoord - 0.5);
        float edge = 1.0 - smoothstep(0.24, 0.5, distanceFromCenter);
        gl_FragColor = vec4(tint.rgb, tint.a * edge);
      }
    `;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || 'Particle shader compilation failed.';
        gl.deleteShader(shader);
        throw new Error(message);
      }
      return shader;
    };

    const vertexShader = compile(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || 'Particle shader link failed.';
      gl.deleteProgram(program);
      throw new Error(message);
    }

    this.program = program;
    this.vertexBuffer = gl.createBuffer();
    this.uniforms = {
      resolution: gl.getUniformLocation(program, 'resolution'),
      ratio: gl.getUniformLocation(program, 'ratio'),
      baseColor: gl.getUniformLocation(program, 'baseColor'),
      accentColor: gl.getUniformLocation(program, 'accentColor'),
    };
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    const stride = 20;
    for (const [name, size, offset] of [
      ['position', 2, 0],
      ['size', 1, 8],
      ['alpha', 1, 12],
      ['warm', 1, 16],
    ]) {
      const attribute = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attribute, size, gl.FLOAT, false, stride, offset);
    }
    if (this.buffer) gl.bufferData(gl.ARRAY_BUFFER, this.buffer.byteLength, gl.DYNAMIC_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
  }

  _bindObservers() {
    document.addEventListener('visibilitychange', this._handleVisibility);
    this.canvas.addEventListener('pointermove', this._handlePointerMove, { passive: true });
    this.canvas.addEventListener('pointerleave', this._handlePointerLeave, { passive: true });
    this.canvas.addEventListener('pointercancel', this._handlePointerLeave, { passive: true });
    this.canvas.addEventListener('pointerdown', this._handlePointerDown, { passive: true });
    this.motionQuery.addEventListener?.('change', this._handleMotionChange);
    if (!this.motionQuery.addEventListener) this.motionQuery.addListener?.(this._handleMotionChange);

    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.stage);
      this.resizeObserver.observe(this.canvas);
    } else {
      this._windowResize = () => this.resize();
      window.addEventListener('resize', this._windowResize, { passive: true });
    }

    if ('IntersectionObserver' in window) {
      this.intersectionObserver = new IntersectionObserver(entries => {
        this.inView = entries[0]?.isIntersecting ?? false;
        if (this.inView) this.lastFrame = performance.now();
        this._syncLoop();
      }, { rootMargin: '80px 0px' });
      this.intersectionObserver.observe(this.stage);
    }

    const syncTheme = () => this.setTheme(this._themeFromDom());
    const themeNodes = [...new Set([document.documentElement, document.body, this.stage].filter(Boolean))];
    this.themeObservers = themeNodes.map(node => {
      const observer = new MutationObserver(syncTheme);
      observer.observe(node, { attributes: true, attributeFilter: ['data-theme'] });
      return observer;
    });
  }

  _buildParticles(count) {
    this.count = count;
    this.ambientCount = Math.round(count * 0.05);
    this.positions = new Float32Array(count * 2);
    this.velocities = new Float32Array(count * 2);
    this.targets = new Float32Array(count * 2);
    this.seed = new Float32Array(count * 4);
    this.buffer = new Float32Array(count * 5);
    const random = seededRandom(55);
    for (let i = 0; i < this.seed.length; i += 1) this.seed[i] = random();
    if (this.gl && !this.contextLost) {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, this.buffer.byteLength, this.gl.DYNAMIC_DRAW);
    }
  }

  _makeTitleTargets() {
    if (!this.count) return;
    const raster = document.createElement('canvas');
    raster.width = Math.max(1, Math.round(this.width));
    raster.height = Math.max(1, Math.round(this.height));
    const context = raster.getContext('2d', { willReadFrequently: true });
    if (!context) return;

    const targetWidth = Math.min(this.width * 0.85, 850);
    const fontCap = Math.min(this.height * 0.8, this.width * 0.44, 350);
    context.font = `italic 100px "${this.fontFamily}", serif`;
    const widthAt100 = context.measureText(this.title).width || 1;
    const fontSize = Math.min(fontCap, targetWidth * 100 / widthAt100);
    context.font = `italic ${fontSize}px "${this.fontFamily}", serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#fff';
    context.fillText(this.title, this.width / 2, this.height / 2);

    const pixels = context.getImageData(0, 0, raster.width, raster.height).data;
    const points = [];
    const step = 1;
    for (let y = 0; y < raster.height; y += step) {
      for (let x = 0; x < raster.width; x += step) {
        if (pixels[(y * raster.width + x) * 4 + 3] > 70) points.push(x, y);
      }
    }

    const available = Math.max(1, points.length / 2);
    for (let i = 0; i < this.count; i += 1) {
      const p = i * 2;
      if (i < this.ambientCount) {
        this.targets[p] = this.seed[i * 4] * this.width;
        this.targets[p + 1] = this.seed[i * 4 + 1] * this.height;
      } else {
        const pointIndex = Math.floor(this.seed[i * 4] * available) * 2;
        this.targets[p] = points[pointIndex] ?? this.width / 2;
        this.targets[p + 1] = points[pointIndex + 1] ?? this.height / 2;
      }
    }
  }

  _settle(resetPosition = false) {
    if (!this.positions || !this.targets) return;
    for (let i = 0; i < this.count; i += 1) {
      const p = i * 2;
      if (resetPosition) {
        this.positions[p] = this.targets[p];
        this.positions[p + 1] = this.targets[p + 1];
      }
      this.velocities[p] = 0;
      this.velocities[p + 1] = 0;
    }
  }

  _frame(now) {
    this.raf = 0;
    if (!this._canAnimate()) return;
    const rawElapsed = Math.max(0, now - this.lastFrame);
    const delta = clamp(rawElapsed / 16.667, 0.25, 2);
    this.lastFrame = now;
    this.time += delta * 16.667;
    const settled = this._update(delta);
    this._draw();

    this.frames += 1;
    this.elapsed += rawElapsed;
    if (this.elapsed >= 1000) {
      this.fps = Math.round((this.frames * 1000) / this.elapsed);
      this.frames = 0;
      this.elapsed = 0;
    }
    if (!this.waves.length && settled) {
      this.settledFrames += 1;
      if (this.settledFrames >= 10) this.dirty = false;
    } else {
      this.settledFrames = 0;
    }
    this._syncLoop();
  }

  _update(delta) {
    const pointerRadius = this.width <= 700 ? 66 : 96;
    this.waves = this.waves.filter(wave => this.time - wave.start < 1300);
    let maxSpeedSquared = 0;
    let maxOffsetSquared = 0;

    for (let i = 0; i < this.count; i += 1) {
      const p = i * 2;
      let x = this.positions[p];
      let y = this.positions[p + 1];
      let vx = this.velocities[p];
      let vy = this.velocities[p + 1];

      if (this.pointer.active) {
        const dx = x - this.pointer.x;
        const dy = y - this.pointer.y;
        const distance = Math.hypot(dx, dy) || 0.001;
        if (distance < pointerRadius) {
          const force = (1 - distance / pointerRadius) * 2.25;
          vx += (dx / distance) * force;
          vy += (dy / distance) * force;
        }
      }

      for (const wave of this.waves) {
        const dx = x - wave.x;
        const dy = y - wave.y;
        const distance = Math.hypot(dx, dy) || 0.001;
        const radius = (this.time - wave.start) * 0.58;
        const band = 1 - Math.abs(distance - radius) / 68;
        if (band > 0) {
          const force = band * wave.strength * 1.8;
          vx += (dx / distance) * force;
          vy += (dy / distance) * force;
        }
      }

      vx = (vx + (this.targets[p] - x) * 0.034 * delta) * Math.pow(0.79, delta);
      vy = (vy + (this.targets[p + 1] - y) * 0.034 * delta) * Math.pow(0.79, delta);
      x += vx * delta;
      y += vy * delta;

      this.positions[p] = x;
      this.positions[p + 1] = y;
      this.velocities[p] = vx;
      this.velocities[p + 1] = vy;
      maxSpeedSquared = Math.max(maxSpeedSquared, vx * vx + vy * vy);
      const offsetX = this.targets[p] - x;
      const offsetY = this.targets[p + 1] - y;
      maxOffsetSquared = Math.max(maxOffsetSquared, offsetX * offsetX + offsetY * offsetY);
    }
    return maxSpeedSquared < 0.0025 && (this.pointer.active || maxOffsetSquared < 0.0625);
  }

  _draw() {
    if (this.destroyed || !this.positions || this.contextLost || this.renderer === 'static') return;
    this._fillBuffer();
    if (this.gl) this._drawWebGL();
    else if (this.ctx) this._drawCanvas();
    if (!this.ready) {
      this.ready = true;
      this.stage.classList.add('is-ready');
    }
  }

  _fillBuffer() {
    for (let i = 0; i < this.count; i += 1) {
      const p = i * 2;
      const b = i * 5;
      const seed = this.seed[i * 4 + 2];
      const ambient = i < this.ambientCount;
      let warm = 0;
      for (const wave of this.waves) {
        const distance = Math.hypot(this.positions[p] - wave.x, this.positions[p + 1] - wave.y);
        const radius = (this.time - wave.start) * 0.58;
        warm = Math.max(warm, clamp(1 - Math.abs(distance - radius) / 54));
      }
      this.buffer[b] = this.positions[p];
      this.buffer[b + 1] = this.positions[p + 1];
      this.buffer[b + 2] = ambient ? 0.6 + seed * 0.8 : 1.1 + seed * 1.2;
      this.buffer[b + 3] = ambient
        ? 0.045 + this.seed[i * 4 + 3] * 0.075
        : 0.7 + this.seed[i * 4 + 3] * 0.28;
      this.buffer[b + 4] = ambient ? 0 : warm;
    }
  }

  _drawWebGL() {
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.buffer);
    gl.drawArrays(gl.POINTS, 0, this.count);
  }

  _drawCanvas() {
    const context = this.ctx;
    const palette = this._palette();
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.clearRect(0, 0, this.width, this.height);
    for (let i = 0; i < this.count; i += 1) {
      const b = i * 5;
      context.globalAlpha = this.buffer[b + 3];
      context.fillStyle = this.buffer[b + 4] > 0.2 ? palette.accentCss : palette.baseCss;
      const size = this.buffer[b + 2];
      context.fillRect(this.buffer[b], this.buffer[b + 1], size, size);
    }
    context.globalAlpha = 1;
  }

  _applyReducedPointer(x, y, amount = 8) {
    this._settle(true);
    const radius = this.width <= 700 ? 58 : 82;
    for (let i = 0; i < this.count; i += 1) {
      const p = i * 2;
      const dx = this.targets[p] - x;
      const dy = this.targets[p + 1] - y;
      const distance = Math.hypot(dx, dy) || 0.001;
      if (distance >= radius) continue;
      const offset = (1 - distance / radius) * amount;
      this.positions[p] += (dx / distance) * offset;
      this.positions[p + 1] += (dy / distance) * offset;
    }
  }

  _handlePointerMove(event) {
    const point = this._localPoint(event);
    this.pointer = { ...point, active: true };
    if (this.reduced) {
      this._applyReducedPointer(point.x, point.y);
      this._draw();
      return;
    }
    if (event.timeStamp - this.lastRipple > 150) {
      this.lastRipple = event.timeStamp;
      this._addWave(point.x, point.y, 0.45);
    }
    this._markDirty();
  }

  _handlePointerLeave() {
    this.pointer.active = false;
    this.pointer.x = -10_000;
    this.pointer.y = -10_000;
    if (this.reduced) {
      this._settle(true);
      this._draw();
    } else {
      this._markDirty();
    }
  }

  _handlePointerDown(event) {
    const point = this._localPoint(event);
    this.pointer = { ...point, active: true };
    this.burst(point.x, point.y);
  }

  _localPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: clamp(event.clientX - rect.left, 0, rect.width || this.width),
      y: clamp(event.clientY - rect.top, 0, rect.height || this.height),
    };
  }

  _addWave(x, y, strength) {
    this.waves.push({ x, y, strength, start: this.time });
    if (this.waves.length > 6) this.waves.shift();
    if (!this.reduced) this._markDirty();
  }

  _handleVisibility() {
    this.lastFrame = performance.now();
    this._syncLoop();
  }

  _handleContextLost(event) {
    event.preventDefault();
    this.contextLost = true;
    this.renderer = 'static';
    this.dirty = true;
    this._cancelFrame();
    this.stage.classList.remove('is-ready');
    this.ready = false;
  }

  _handleContextRestored() {
    try {
      this.contextLost = false;
      this.gl = this.canvas.getContext('webgl');
      this._createWebGLResources();
      this.renderer = 'webgl';
      this.resize();
      this._draw();
      this._markDirty();
    } catch (error) {
      this.contextLost = true;
      this.renderer = 'static';
      this.stage.classList.remove('is-ready');
      console.warn('Hero particle WebGL context could not be restored.', error);
    }
  }

  _loadFont() {
    if (!document.fonts?.load) return;
    document.fonts.load(`italic 96px "${this.fontFamily}"`, this.title).then(() => {
      if (this.destroyed) return;
      this._makeTitleTargets();
      this._settle(true);
      this._requestRender();
    }).catch(() => {});
  }

  _themeFromDom() {
    const owner = this.canvas?.closest?.('[data-theme]');
    const value = owner?.dataset.theme || document.documentElement.dataset.theme || document.body?.dataset.theme;
    return value === 'paper' ? 'paper' : 'ink';
  }

  _palette() {
    return this.theme === 'paper'
      ? { base: [0.12, 0.12, 0.105], accent: [0.63, 0.25, 0.17], baseCss: '#1f1f1b', accentCss: '#a1402b' }
      : { base: [0.925, 0.914, 0.865], accent: [0.89, 0.53, 0.38], baseCss: '#ece9dc', accentCss: '#e38761' };
  }

  _applyThemeUniforms() {
    if (!this.gl || this.contextLost || !this.program) return;
    const palette = this._palette();
    this.gl.useProgram(this.program);
    this.gl.uniform3fv(this.uniforms.baseColor, palette.base);
    this.gl.uniform3fv(this.uniforms.accentColor, palette.accent);
  }

  _canAnimate() {
    return this.wantsToRun && this.dirty && !this.destroyed && !this.reduced && !document.hidden && this.inView && this.renderer !== 'static' && !this.contextLost;
  }

  _syncLoop() {
    if (this._canAnimate()) {
      if (!this.raf) this.raf = requestAnimationFrame(this._frame);
    } else {
      this._cancelFrame();
    }
  }

  _cancelFrame() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  _markDirty() {
    if (this.destroyed || this.reduced) return;
    this.dirty = true;
    this.settledFrames = 0;
    if (!this.raf) this.lastFrame = performance.now();
    this._syncLoop();
  }

  _requestRender() {
    if (this.destroyed || this.renderer === 'static' || this.contextLost) return;
    if (document.hidden || !this.inView) {
      this.dirty = true;
      return;
    }
    if (this.reduced || !this.wantsToRun) this._draw();
    else this._markDirty();
  }
}

export default HeroParticles;
