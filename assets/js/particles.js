const TAU = Math.PI * 2;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const mix = (from, to, amount) => from + (to - from) * amount;
const smooth = (from, to, value) => {
  const amount = clamp((value - from) / (to - from));
  return amount * amount * (3 - 2 * amount);
};

function randomGenerator(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function copyRect(rect, canvasRect) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: (rect.x ?? rect.left) - canvasRect.left,
    y: (rect.y ?? rect.top) - canvasRect.top,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * One persistent particle pool that morphs through six scroll-driven scenes.
 * Scene geometry is viewport-relative; the controller supplies live DOM rects.
 */
export class ParticleExperience {
  constructor(canvas, { title = 'Alcedo' } = {}) {
    if (!canvas?.getContext) throw new TypeError('ParticleExperience requires a canvas.');
    this.canvas = canvas;
    this.parent = canvas.parentElement;
    this.titleText = title;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.mobile = false;
    this.progress = 0;
    this.temperature = 0.3;
    this.effort = 2;
    this.theme = 'ink';
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.pointer = { x: -2000, y: -2000 };
    this.waves = [];
    this.time = 0;
    this.last = performance.now();
    this.frames = 0;
    this.elapsed = 0;
    this.fps = 0;
    this.raf = 0;
    this.wantsToRun = false;
    this.visible = !document.hidden;
    this.contextLost = false;
    this.destroyed = false;
    this.first = true;
    this.ready = false;
    this.renderer = 'static';
    this.poolVersion = 0;
    this.layout = {};
    this.frame = this.frame.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onContextLost = this._onContextLost.bind(this);
    this._onContextRestored = this._onContextRestored.bind(this);
    this._onMotion = event => this.setReducedMotion(event.matches);

    this.motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
    this._setupRenderer();
    this.canvas.addEventListener('webglcontextlost', this._onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this._onContextRestored);
    document.addEventListener('visibilitychange', this._onVisibility);
    if (this.motionQuery.addEventListener) this.motionQuery.addEventListener('change', this._onMotion);
    else this.motionQuery.addListener?.(this._onMotion);

    this.resize();
    queueMicrotask(() => { if (!this.destroyed) this._dispatchState(); });
    document.fonts?.load?.('italic 180px Instrument', this.titleText).then(() => {
      if (this.destroyed) return;
      this._makeTitle();
      if (this.reduced) this._snapToTargets();
      else this._wake();
    }).catch(() => {});
  }

  get metrics() {
    return {
      scene: Math.min(5, Math.floor(this.progress)),
      progress: this.progress,
      renderer: this.renderer,
      count: this.count || 0,
      running: Boolean(this.raf),
      reduced: this.reduced,
      fps: this.fps,
      poolVersion: this.poolVersion,
    };
  }

  resize(layout = {}) {
    if (this.destroyed) return this;
    const canvasRect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, canvasRect.width || innerWidth);
    const height = Math.max(1, canvasRect.height || innerHeight);
    const mobile = width <= 700;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const breakpointChanged = !this.count || mobile !== this.mobile;
    this.width = width;
    this.height = height;
    this.mobile = mobile;
    this.dpr = dpr;
    this.layout = {
      project: copyRect(layout.project, canvasRect),
      code: copyRect(layout.code, canvasRect),
      notes: (layout.notes || []).map(rect => copyRect(rect, canvasRect)).filter(Boolean),
      final: copyRect(layout.final, canvasRect),
      finalButton: copyRect(layout.finalButton, canvasRect),
    };

    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
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

    if (breakpointChanged) this._allocatePool();
    this._buildGeometry();
    if (this.reduced) this._snapToTargets();
    else this._wake();
    return this;
  }

  setProgress(value) {
    this.progress = clamp(Number(value) || 0, 0, 5.82);
    if (this.reduced) this._snapToTargets();
    else this._wake();
    return this;
  }

  setTheme(theme = 'ink') {
    this.theme = theme === 'paper' ? 'paper' : 'ink';
    if (this.reduced) this._renderStatic();
    else if (!this.wantsToRun) {
      if (this.first) this._snapToTargets();
      else this._renderStatic();
    }
    else this._wake();
    return this;
  }

  setReducedMotion(value) {
    this.reduced = Boolean(value);
    this._cancelFrame();
    this.waves.length = 0;
    this.last = performance.now();
    if (this.reduced) this._snapToTargets();
    else this._wake();
    return this;
  }

  setPointer(x, y) {
    this.pointer.x = x;
    this.pointer.y = y;
    if (!this.reduced) this._wake();
    return this;
  }

  clearPointer() {
    this.pointer.x = -2000;
    this.pointer.y = -2000;
    if (!this.reduced) this._wake();
    return this;
  }

  pulse(x = this.width / 2, y = this.height / 2, strength = 1) {
    this.waves.push({ x, y, start: this.time, strength });
    if (this.waves.length > 8) this.waves.shift();
    if (this.reduced) this._renderStatic();
    else this._wake();
    return this;
  }

  burst() {
    const rect = this.layout.project;
    const x = rect ? rect.x + rect.width / 2 : this.width / 2;
    const y = rect ? rect.y + rect.height / 2 : this.height / 2;
    this.pulse(x, y, 2.4);
    if (this.reduced) return this;
    for (let i = 0; i < this.count; i += 1) {
      const q = i * 4;
      const angle = this.seed[q] * TAU;
      const speed = 12 + this.seed[q + 1] * 45;
      this.xyz[q + 2] += Math.cos(angle) * speed;
      this.xyz[q + 3] += Math.sin(angle) * speed;
    }
    this._wake();
    return this;
  }

  start() {
    if (this.destroyed) return this;
    this.wantsToRun = true;
    this.last = performance.now();
    if (this.reduced) this._snapToTargets();
    else this._wake();
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
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    this.motionQuery.removeEventListener?.('change', this._onMotion);
    this.motionQuery.removeListener?.(this._onMotion);
    if (this.gl) {
      if (this.vertexBuffer) this.gl.deleteBuffer(this.vertexBuffer);
      if (this.program) this.gl.deleteProgram(this.program);
    }
    this.canvas.removeAttribute('data-ready');
    this.parent?.classList.remove('is-ready');
  }

  sample() {
    return Array.from(this.xyz?.slice(0, 40) || []);
  }

  _setupRenderer() {
    let gl = null;
    try {
      gl = this.canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
        powerPreference: 'high-performance',
      });
    } catch { /* readable HTML fallback remains */ }
    if (gl) {
      try {
        this.gl = gl;
        this._createWebGLResources();
        this.renderer = 'webgl';
        return;
      } catch (error) {
        console.warn('Particle WebGL setup failed.', error);
        this.gl = null;
      }
    }
    try { this.ctx = this.canvas.getContext('2d', { alpha: true }); }
    catch { this.ctx = null; }
    this.renderer = this.ctx ? 'canvas' : 'static';
  }

  _createWebGLResources() {
    const gl = this.gl;
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
    const vertex = compile(gl.VERTEX_SHADER, `
      attribute vec2 position; attribute float size; attribute vec4 color;
      uniform vec2 resolution; uniform float ratio; varying vec4 tint;
      void main(){vec2 p=position/resolution;gl_Position=vec4(p.x*2.0-1.0,1.0-p.y*2.0,0.0,1.0);gl_PointSize=size*ratio;tint=color;}
    `);
    const fragment = compile(gl.FRAGMENT_SHADER, `
      precision mediump float; varying vec4 tint;
      void main(){float d=length(gl_PointCoord-.5);gl_FragColor=vec4(tint.rgb,tint.a*(1.0-smoothstep(.24,.5,d)));}
    `);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Particle shader link failed.');
    this.program = program;
    this.vertexBuffer = gl.createBuffer();
    this.uniforms = {
      resolution: gl.getUniformLocation(program, 'resolution'),
      ratio: gl.getUniformLocation(program, 'ratio'),
    };
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    if (this.buffer) gl.bufferData(gl.ARRAY_BUFFER, this.buffer.byteLength, gl.DYNAMIC_DRAW);
    for (const [name, size, offset] of [['position', 2, 0], ['size', 1, 8], ['color', 4, 12]]) {
      const attribute = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attribute, size, gl.FLOAT, false, 28, offset);
    }
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
  }

  _allocatePool() {
    const desired = this.renderer === 'webgl' ? (this.mobile ? 10000 : 19000) : Math.min(1800, this.mobile ? 10000 : 19000);
    this.count = desired;
    this.xyz = new Float32Array(desired * 4);
    this.seed = new Float32Array(desired * 4);
    this.buffer = new Float32Array(desired * 7);
    const random = randomGenerator(55);
    for (let i = 0; i < this.seed.length; i += 1) this.seed[i] = random();
    if (this.gl && !this.contextLost) {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, this.buffer.byteLength, this.gl.DYNAMIC_DRAW);
    }
    this.poolVersion += 1;
    this.first = true;
  }

  _buildGeometry() {
    this._makeTitle();
    this._buildTree();
    this.projectPoints = [];
    this.notePoints = [];
    this.finalPoints = [];
    const w = this.width;
    const h = this.height;
    const project = this.layout.project || { x: w * 0.57, y: h * 0.27, width: w * 0.34, height: h * 0.46 };
    const code = this.layout.code || { x: w * 0.08, y: h * 0.34, width: w * 0.34, height: h * 0.36 };
    const headerOffset = this.mobile ? 30 : 44;
    this._sampleRounded(this.projectPoints, project, 16);
    this._sampleLine(this.projectPoints, project.x + 14, project.y + headerOffset, project.x + project.width - 14, project.y + headerOffset, 520);
    this._sampleRounded(this.projectPoints, code, 10);
    this._sampleLine(this.projectPoints, code.x + 14, code.y + headerOffset, code.x + code.width - 14, code.y + headerOffset, 420);

    const notes = this.layout.notes.length ? this.layout.notes : [
      { x: w * 0.16, y: h * 0.28, width: w * 0.28, height: h * 0.46 },
      { x: w * 0.56, y: h * 0.28, width: w * 0.28, height: h * 0.46 },
    ];
    for (const note of notes.slice(0, 2)) {
      this._sampleRounded(this.notePoints, note, 5);
      this._sampleLine(this.notePoints, note.x + 14, note.y + headerOffset, note.x + note.width - 14, note.y + headerOffset, 360);
      const fold = Math.min(20, note.width * 0.12, note.height * 0.12);
      this._sampleLine(this.notePoints, note.x + note.width - fold, note.y, note.x + note.width, note.y + fold, 90);
    }

    const finalRect = this.layout.final || { x: w * 0.25, y: h * 0.43, width: w * 0.5, height: Math.min(86, h * 0.15) };
    const finalButton = this.layout.finalButton || {
      x: finalRect.x + finalRect.width - finalRect.height,
      y: finalRect.y,
      width: finalRect.height,
      height: finalRect.height,
    };
    this._sampleRounded(this.finalPoints, finalRect, finalRect.height / 2);
    this._sampleRounded(this.finalPoints, finalButton, Math.min(finalButton.width, finalButton.height) / 2);
    this._buildFlow();
  }

  _makeTitle() {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(this.width));
    canvas.height = Math.max(1, Math.round(this.height));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) { this.title = [this.width / 2, this.height / 2]; return; }
    const size = this.mobile ? this.width * 0.225 : this.width * 0.0958;
    context.font = `italic ${size}px Instrument, serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#fff';
    context.fillText(this.titleText, this.width / 2, this.height / 2);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const points = [];
    for (let y = Math.max(0, Math.floor(this.height / 2 - size)); y < Math.min(canvas.height, this.height / 2 + size); y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 70) points.push(x, y);
      }
    }
    this.title = points.length ? points : [this.width / 2, this.height / 2];
  }

  _buildTree() {
    const w = this.width;
    const h = this.height;
    const random = randomGenerator(5501);
    this.edges = [];
    this.treeNodes = [];
    const startX = this.mobile ? w * 0.10 : w * 0.455;
    const endX = this.mobile ? w * 0.91 : w * 0.91;
    const centerY = this.mobile ? h * 0.66 : h * 0.515;
    const spread = this.mobile ? h * 0.20 : h * 0.325;
    this.treeCenter = { x: startX, y: centerY };
    const root = { x: startX, y: centerY, id: 0 };
    this.treeNodes.push(root);
    let id = 1;
    const walk = (node, depth, min, max, chosen) => {
      if (depth === 4) return;
      const branches = depth === 0 ? 3 : 2;
      for (let j = 0; j < branches; j += 1) {
        const low = min + ((max - min) * j) / branches;
        const high = min + ((max - min) * (j + 1)) / branches;
        const destination = {
          x: mix(startX, endX, (depth + 1) / 4) + (depth === 3 ? 0 : (random() - 0.5) * w * 0.02),
          y: centerY + ((low + high) / 2) * spread + (random() - 0.5) * spread * 0.045,
          id: id++,
        };
        const selected = chosen && j === (depth === 0 || depth === 1 ? 1 : 0);
        this.edges.push({ a: node, b: destination, depth, selected });
        this.treeNodes.push(destination);
        walk(destination, depth + 1, low, high, selected);
      }
    };
    walk(root, 0, -1.05, 1.05, true);
  }

  _buildFlow() {
    const w = this.width;
    const h = this.height;
    const compact = this.mobile && h <= 650;
    const centerY = this.mobile ? h * (compact ? 0.64 : 0.67) : h * 0.51;
    const left = this.mobile ? w * 0.12 : w * 0.47;
    const middle = this.mobile ? w * 0.51 : w * 0.68;
    const right = this.mobile ? w * 0.87 : w * 0.90;
    const middleRows = this.mobile ? (compact ? [h * 0.50, h * 0.64, h * 0.78] : [h * 0.51, h * 0.67, h * 0.83]) : [h * 0.28, h * 0.51, h * 0.74];
    this.flowNodes = [{ x: left, y: centerY, label: '실험', r: this.mobile ? 12 : 18 }];
    ['Hugo', 'Velog', 'GitHub'].forEach((label, index) => {
      this.flowNodes.push({ x: middle, y: middleRows[index], label, r: this.mobile ? 13 : 21 });
    });
    this.flowNodes.push({ x: right, y: centerY, label: '기록', r: this.mobile ? 14 : 18 });
    this.flowEdges = [];
    for (let index = 1; index <= 3; index += 1) {
      this.flowEdges.push({ a: this.flowNodes[0], b: this.flowNodes[index], index, out: false });
      this.flowEdges.push({ a: this.flowNodes[index], b: this.flowNodes[4], index, out: true });
    }
  }

  _sampleLine(points, x1, y1, x2, y2, count) {
    for (let i = 0; i < count; i += 1) {
      const amount = count <= 1 ? 0 : i / (count - 1);
      points.push(mix(x1, x2, amount), mix(y1, y2, amount));
    }
  }

  _sampleRounded(points, rect, radius) {
    if (!rect) return;
    const r = Math.min(radius, rect.width / 2, rect.height / 2);
    const perimeter = 2 * (rect.width + rect.height - 4 * r) + TAU * r;
    const count = Math.max(160, Math.round(perimeter * 2.4));
    const pushArc = (cx, cy, start, length, offset) => {
      const samples = Math.max(18, Math.round((length / perimeter) * count));
      for (let i = 0; i < samples; i += 1) {
        const angle = start + (i / Math.max(1, samples - 1)) * offset;
        points.push(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
      }
    };
    this._sampleLine(points, rect.x + r, rect.y, rect.x + rect.width - r, rect.y, Math.max(12, Math.round(rect.width * 2)));
    pushArc(rect.x + rect.width - r, rect.y + r, -Math.PI / 2, Math.PI * r / 2, Math.PI / 2);
    this._sampleLine(points, rect.x + rect.width, rect.y + r, rect.x + rect.width, rect.y + rect.height - r, Math.max(12, Math.round(rect.height * 2)));
    pushArc(rect.x + rect.width - r, rect.y + rect.height - r, 0, Math.PI * r / 2, Math.PI / 2);
    this._sampleLine(points, rect.x + rect.width - r, rect.y + rect.height, rect.x + r, rect.y + rect.height, Math.max(12, Math.round(rect.width * 2)));
    pushArc(rect.x + r, rect.y + rect.height - r, Math.PI / 2, Math.PI * r / 2, Math.PI / 2);
    this._sampleLine(points, rect.x, rect.y + rect.height - r, rect.x, rect.y + r, Math.max(12, Math.round(rect.height * 2)));
    pushArc(rect.x + r, rect.y + r, Math.PI, Math.PI * r / 2, Math.PI / 2);
  }

  _target(stage, index, local, out) {
    const w = this.width;
    const h = this.height;
    const q = index * 4;
    const a = this.seed[q];
    const b = this.seed[q + 1];
    const c = this.seed[q + 2];
    const d = this.seed[q + 3];
    out[2] = 0;
    out[3] = 0.65;
    out[4] = 0.8 + d * 0.5;

    if (stage > 0 && index < this.count * 0.09) {
      out[0] = ((a * w + this.time * 0.003 * (b - 0.4)) % w + w) % w;
      out[1] = ((c * h + Math.sin(this.time * 0.0001 + a * 10) * 12) % h + h) % h;
      out[3] = 0.035 + d * 0.075;
      out[4] = 0.4 + d * 0.6;
      return;
    }

    if (stage === 0) {
      const point = Math.floor(a * (this.title.length / 2)) * 2;
      out[0] = this.title[point] + Math.sin(this.time * 0.0005 + b * TAU) * 0.55;
      out[1] = this.title[point + 1] + Math.cos(this.time * 0.0006 + c * TAU) * 0.55;
      out[3] = 0.5 + d * 0.5;
      out[4] = 0.65 + d * 0.5;
      return;
    }

    if (stage === 1) {
      const edge = this.edges[Math.floor(a * this.edges.length)];
      const amount = (b + this.time * 0.000006 * (0.4 + c)) % 1;
      const eased = amount * amount * (3 - 2 * amount);
      const spread = (0.35 + c * 1.4) * (1 + (this.effort < 2 ? (2 - this.effort) * 0.6 : 0));
      out[0] = mix(edge.a.x, edge.b.x, amount) + Math.sin(d * TAU + this.time * 0.001) * spread;
      out[1] = mix(edge.a.y, edge.b.y, eased) + Math.cos(c * TAU + this.time * 0.001) * spread;
      if (edge.selected && (edge.depth + amount) / 4 < smooth(0.3, 0.92, local) * 1.2) out[2] = 0.8;
      out[3] = mix(0.70, edge.selected ? 0.85 : 0.12, smooth(0.58, 0.91, local)) * (0.4 + d * 0.6);
      out[4] = 0.65 + d * 0.65;
      if (this.effort < 4 && edge.depth === 3 && c > (this.effort + 1) / 5) {
        out[0] += (c - 0.4) * 42;
        out[1] += (d - 0.5) * 45;
        out[3] *= 0.4;
      }
      return;
    }

    if (stage === 2) {
      const point = Math.floor(a * (this.projectPoints.length / 2)) * 2;
      out[0] = this.projectPoints[point] ?? w * 0.72;
      out[1] = this.projectPoints[point + 1] ?? h * 0.5;
      out[0] += Math.sin(this.time * 0.0012 + b * TAU) * (0.3 + this.temperature * 1.6);
      out[1] += Math.cos(this.time * 0.001 + c * TAU) * (0.3 + this.temperature * 1.6);
      out[2] = Math.max(0, (this.temperature - 0.35) * 1.45);
      out[3] = (0.22 + d * 0.34) * smooth(0.08, 0.34, local);
      out[4] = 0.45 + d * 0.35;
      return;
    }

    if (stage === 3) {
      const point = Math.floor(a * (this.notePoints.length / 2)) * 2;
      const sheetX = this.notePoints[point] ?? w * 0.5;
      const sheetY = this.notePoints[point + 1] ?? h * 0.5;
      const collapse = smooth(0.58, 0.94, local);
      const group = Math.floor(a * 460);
      const angle = group * 2.399963 + Math.sin(group) * 0.1;
      const radius = Math.sqrt((group + 0.5) / 460) * (this.mobile ? w * 0.22 : w * 0.16);
      const turn = collapse * collapse * 8 + this.time * 0.00002;
      const centerX = w * 0.68;
      const centerY = this.mobile ? h * 0.64 : h * 0.51;
      const spiralX = centerX + Math.cos(angle + turn * (1 + a * 0.8)) * (radius * (1 - collapse) + 10);
      const spiralY = centerY + Math.sin(angle + turn * (1 + a * 0.8)) * (radius * (1 - collapse) + 10) * (this.mobile ? 0.83 : 0.75);
      out[0] = mix(sheetX, spiralX, collapse);
      out[1] = mix(sheetY, spiralY, collapse);
      out[2] = collapse > 0.55 ? (collapse - 0.55) * 2 : 0;
      out[3] = mix(0.72, 0.9, collapse) * (0.65 + d * 0.35);
      out[4] = mix(0.72, 1.2, collapse);
      return;
    }

    if (stage === 4) {
      if (a < 0.48) {
        const node = this.flowNodes[Math.floor((a / 0.48) * this.flowNodes.length)];
        const angle = b * TAU;
        const isMiddle = node !== this.flowNodes[0] && node !== this.flowNodes[4];
        const filled = local > 0.25 && isMiddle;
        const radius = node.r * (filled ? Math.sqrt(c) : 1 + (c - 0.5) * 0.07);
        out[0] = node.x + Math.cos(angle) * radius;
        out[1] = node.y + Math.sin(angle) * radius;
        out[3] = filled ? 0.73 : 0.75;
      } else {
        const edge = this.flowEdges[Math.floor(((a - 0.48) / 0.52) * this.flowEdges.length)];
        const amount = (b + this.time * 0.000011) % 1;
        const eased = amount * amount * (3 - 2 * amount);
        out[0] = mix(edge.a.x, edge.b.x, amount) + (c - 0.5) * 1.5;
        out[1] = mix(edge.a.y, edge.b.y, eased) + (d - 0.5) * 1.5;
        const reveal = smooth(0.06 + edge.index * 0.05, 0.30 + edge.index * 0.06, local);
        out[3] = amount < reveal ? 0.35 : 0;
        out[2] = edge.out ? 0.75 : 0;
        if (edge.out && local < 0.45) out[3] = 0;
      }
      out[4] = 0.65 + d * 0.5;
      return;
    }

    const point = Math.floor(a * (this.finalPoints.length / 2)) * 2;
    out[0] = (this.finalPoints[point] ?? w * 0.5) + Math.sin(b * TAU + this.time * 0.001) * 0.9;
    out[1] = (this.finalPoints[point + 1] ?? h * 0.56) + Math.cos(c * TAU + this.time * 0.001) * 0.9;
    out[3] = 0.30 + d * 0.52;
    out[4] = 0.65 + d * 0.7;
  }

  frame(now) {
    this.raf = 0;
    if (!this._canRun()) return;
    const rawElapsed = Math.max(0, now - this.last);
    const delta = clamp(rawElapsed / 16.667, 0.25, 2);
    this.last = now;
    this.time += delta * 16.667;
    this._update(delta);
    this._draw();
    this.frames += 1;
    this.elapsed += rawElapsed;
    if (this.elapsed >= 1000) {
      this.fps = Math.round((this.frames * 1000) / this.elapsed);
      this.frames = 0;
      this.elapsed = 0;
    }
    this._schedule();
  }

  _update(delta) {
    const stage = Math.min(5, Math.floor(this.progress));
    const local = this.progress - stage;
    const transition = stage < 5 ? smooth(0.81, 1, local) : 0;
    const target = [0, 0, 0, 0, 0];
    const next = [0, 0, 0, 0, 0];
    this.waves = this.waves.filter(wave => this.time - wave.start < 1800);
    for (let i = 0; i < this.count; i += 1) {
      const q = i * 4;
      this._target(stage, i, local, target);
      if (transition > 0) {
        this._target(stage + 1, i, 0, next);
        for (let value = 0; value < 5; value += 1) target[value] = mix(target[value], next[value], transition);
      }
      if (this.first) {
        this.xyz[q] = target[0];
        this.xyz[q + 1] = target[1];
      }
      let x = this.xyz[q];
      let y = this.xyz[q + 1];
      let vx = this.xyz[q + 2];
      let vy = this.xyz[q + 3];
      const pointerX = x - this.pointer.x;
      const pointerY = y - this.pointer.y;
      const pointerDistance = Math.hypot(pointerX, pointerY);
      const pointerRadius = this.mobile ? 62 : 95;
      if (pointerDistance < pointerRadius && pointerDistance > 0.1) {
        const force = (1 - pointerDistance / pointerRadius) * 2.1;
        vx += (pointerX / pointerDistance) * force;
        vy += (pointerY / pointerDistance) * force;
      }
      for (const wave of this.waves) {
        const dx = x - wave.x;
        const dy = y - wave.y;
        const distance = Math.hypot(dx, dy) + 0.001;
        const radius = (this.time - wave.start) * 0.65;
        const band = 1 - Math.abs(distance - radius) / 85;
        if (band > 0) {
          const force = band * wave.strength * 2.2;
          vx += (dx / distance) * force;
          vy += (dy / distance) * force;
        }
      }
      vx = (vx + (target[0] - x) * 0.032 * delta) * Math.pow(0.79, delta);
      vy = (vy + (target[1] - y) * 0.032 * delta) * Math.pow(0.79, delta);
      x += vx * delta;
      y += vy * delta;
      this.xyz[q] = x;
      this.xyz[q + 1] = y;
      this.xyz[q + 2] = vx;
      this.xyz[q + 3] = vy;
      this._writeBuffer(i, x, y, target);
    }
    this.first = false;
  }

  _writeBuffer(index, x, y, target) {
    const offset = index * 7;
    const ink = this.theme === 'ink';
    const baseR = ink ? 0.925 : 0.12;
    const baseG = ink ? 0.914 : 0.12;
    const baseB = ink ? 0.865 : 0.105;
    const accentR = ink ? 0.89 : 0.63;
    const accentG = ink ? 0.53 : 0.25;
    const accentB = ink ? 0.38 : 0.17;
    const warm = clamp(target[2]);
    this.buffer[offset] = x;
    this.buffer[offset + 1] = y;
    this.buffer[offset + 2] = target[4] * 1.6;
    this.buffer[offset + 3] = mix(baseR, accentR, warm);
    this.buffer[offset + 4] = mix(baseG, accentG, warm);
    this.buffer[offset + 5] = mix(baseB, accentB, warm);
    this.buffer[offset + 6] = target[3];
  }

  _draw() {
    if (this.contextLost || this.renderer === 'static') return;
    if (this.gl) {
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
      this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, this.buffer);
      this.gl.drawArrays(this.gl.POINTS, 0, this.count);
    } else if (this.ctx) {
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.ctx.clearRect(0, 0, this.width, this.height);
      for (let i = 0; i < this.count; i += 1) {
        const offset = i * 7;
        this.ctx.fillStyle = `rgba(${this.buffer[offset + 3] * 255},${this.buffer[offset + 4] * 255},${this.buffer[offset + 5] * 255},${this.buffer[offset + 6]})`;
        this.ctx.fillRect(this.buffer[offset], this.buffer[offset + 1], this.buffer[offset + 2], this.buffer[offset + 2]);
      }
    }
    this._setReady(true);
  }

  _snapToTargets() {
    if (!this.xyz) return;
    const stage = Math.min(5, Math.floor(this.progress));
    const local = this.progress - stage;
    const transition = stage < 5 ? smooth(0.81, 1, local) : 0;
    const target = [0, 0, 0, 0, 0];
    const next = [0, 0, 0, 0, 0];
    for (let i = 0; i < this.count; i += 1) {
      this._target(stage, i, local, target);
      if (transition > 0) {
        this._target(stage + 1, i, 0, next);
        for (let value = 0; value < 5; value += 1) target[value] = mix(target[value], next[value], transition);
      }
      const q = i * 4;
      this.xyz[q] = target[0];
      this.xyz[q + 1] = target[1];
      this.xyz[q + 2] = 0;
      this.xyz[q + 3] = 0;
      this._writeBuffer(i, target[0], target[1], target);
    }
    this.first = false;
    this._draw();
  }

  _renderStatic() {
    if (!this.xyz) return;
    const stage = Math.min(5, Math.floor(this.progress));
    const local = this.progress - stage;
    const target = [0, 0, 0, 0, 0];
    for (let i = 0; i < this.count; i += 1) {
      const q = i * 4;
      this._target(stage, i, local, target);
      this._writeBuffer(i, this.xyz[q], this.xyz[q + 1], target);
    }
    this._draw();
  }

  _wake() {
    if (!this.raf) this.last = performance.now();
    this._schedule();
  }

  _canRun() {
    return this.wantsToRun && this.visible && !this.reduced && !this.destroyed && !this.contextLost && this.renderer !== 'static';
  }

  _schedule() {
    if (this._canRun()) {
      if (!this.raf) this.raf = requestAnimationFrame(this.frame);
    } else this._cancelFrame();
  }

  _cancelFrame() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  _onVisibility() {
    this.visible = !document.hidden;
    this.last = performance.now();
    this._schedule();
  }

  _onContextLost(event) {
    event.preventDefault();
    const wasReady = this.ready;
    this.contextLost = true;
    this.renderer = 'static';
    this._cancelFrame();
    this._setReady(false);
    if (!wasReady) this._dispatchState();
  }

  _onContextRestored() {
    try {
      this.contextLost = false;
      this.gl = this.canvas.getContext('webgl');
      this._createWebGLResources();
      this.renderer = 'webgl';
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.gl.uniform2f(this.uniforms.resolution, this.width, this.height);
      this.gl.uniform1f(this.uniforms.ratio, this.dpr);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, this.buffer, this.gl.DYNAMIC_DRAW);
      if (this.reduced) this._snapToTargets();
      else this._wake();
      this._dispatchState();
    } catch (error) {
      this.contextLost = true;
      this.renderer = 'static';
      this._setReady(false);
      console.warn('Particle WebGL context could not be restored.', error);
    }
  }

  _setReady(value) {
    if (this.ready === value) return;
    this.ready = value;
    if (value) {
      this.canvas.dataset.ready = 'true';
      this.parent?.classList.add('is-ready');
    } else {
      this.canvas.removeAttribute('data-ready');
      this.parent?.classList.remove('is-ready');
    }
    this._dispatchState();
  }

  _dispatchState() {
    this.canvas.dispatchEvent(new CustomEvent('particlestatechange', { detail: this.metrics }));
  }
}

export default ParticleExperience;
