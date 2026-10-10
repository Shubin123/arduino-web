// SPDX-License-Identifier: AGPL-3.0-or-later
// Serial plotter. Accepts the same line format as the Arduino IDE plotter:
// values separated by spaces, tabs or commas, optionally as `label:value`.
const COLORS = ['#0ca1a6', '#edae49', '#c95a77', '#4e7ac7', '#7b9e3f', '#a46cd5', '#d97a3a', '#5c6b73'];

export class Plotter {
  constructor(canvas, legend) {
    this.canvas = canvas;
    this.legend = legend;
    this.series = new Map();
    this.window = 50;
    this.paused = false;
    this.buffer = '';
    this.interpolate = true;
  }

  push(text) {
    this.buffer += text;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop();
    if (this.paused) return;
    for (const line of lines) this.parseLine(line);
    this.scheduleDraw();
  }

  parseLine(line) {
    const parts = line.trim().split(/[\s,]+/).filter(Boolean);
    if (!parts.length) return;
    let index = 0;
    for (const part of parts) {
      const m = part.match(/^(?:([^:]+):)?(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)$/);
      if (!m) continue;
      const label = m[1] ?? `value ${++index}`;
      if (!this.series.has(label)) this.series.set(label, { values: [], visible: true, color: COLORS[this.series.size % COLORS.length] });
      const s = this.series.get(label);
      s.values.push(Number(m[2]));
      if (s.values.length > 5000) s.values.splice(0, s.values.length - 5000);
    }
    this.renderLegend();
  }

  clear() {
    this.series.clear();
    this.buffer = '';
    this.renderLegend();
    this.draw();
  }

  renderLegend() {
    if (this.legend.childElementCount === this.series.size) return;
    this.legend.replaceChildren(
      ...[...this.series].map(([label, s]) => {
        const item = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = s.visible;
        box.onchange = () => { s.visible = box.checked; this.draw(); };
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = s.color;
        item.append(box, swatch, label);
        return item;
      }),
    );
  }

  scheduleDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  draw() {
    const c = this.canvas;
    const ratio = devicePixelRatio || 1;
    const width = c.clientWidth;
    const height = c.clientHeight;
    if (!width || !height) return;
    c.width = width * ratio;
    c.height = height * ratio;
    const ctx = c.getContext('2d');
    ctx.scale(ratio, ratio);
    const style = getComputedStyle(c);
    ctx.fillStyle = style.getPropertyValue('--plot-bg') || '#fff';
    ctx.fillRect(0, 0, width, height);
    const visible = [...this.series.values()].filter((s) => s.visible);
    const windows = visible.map((s) => s.values.slice(-this.window));
    const all = windows.flat();
    if (!all.length) return;
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const left = 56, right = 10, top = 10, bottom = 22;
    const x = (i) => left + (i / Math.max(1, this.window - 1)) * (width - left - right);
    const y = (v) => top + (1 - (v - lo) / (hi - lo)) * (height - top - bottom);
    ctx.font = '11px system-ui, sans-serif';
    ctx.strokeStyle = style.getPropertyValue('--plot-grid') || '#ddd';
    ctx.fillStyle = style.getPropertyValue('--plot-text') || '#555';
    ctx.lineWidth = 1;
    for (let k = 0; k <= 5; k++) {
      const v = lo + ((hi - lo) * k) / 5;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(width - right, yy); ctx.stroke();
      ctx.fillText(Number(v.toPrecision(4)).toString(), 4, yy + 4);
    }
    ctx.lineWidth = 2;
    visible.forEach((s, n) => {
      const values = windows[n];
      const offset = this.window - values.length;
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      values.forEach((v, i) => (i ? ctx.lineTo(x(i + offset), y(v)) : ctx.moveTo(x(i + offset), y(v))));
      ctx.stroke();
    });
  }
}
