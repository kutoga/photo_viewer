'use strict';
class PhotoZoom {
  constructor(stage, image, onDetail) {
    this.stage = stage;
    this.image = image;
    this.onDetail = onDetail;
    this.reset();
    image.draggable = false;
    image.addEventListener('load', () => this.render());
    stage.addEventListener(
      'wheel',
      (event) => {
        if (!this.enabled || !image.naturalWidth) return;
        event.preventDefault();
        const bounds = stage.getBoundingClientRect();
        this.change(
          this.zoom * Math.exp(-Math.sign(event.deltaY) * 0.18),
          event.clientX - bounds.x - bounds.width / 2,
          event.clientY - bounds.y - bounds.height / 2,
        );
        if (this.zoom > 1) this.onDetail(false);
      },
      { passive: false },
    );
    stage.addEventListener('dblclick', (event) => {
      if (!this.enabled || event.target.closest('button')) return;
      event.preventDefault();
      if (this.zoom !== 1) this.fit();
      else this.onDetail(true);
    });
    stage.addEventListener('pointerdown', (event) => {
      if (!this.enabled || this.zoom <= 1 || event.button !== 0 || event.target.closest('button'))
        return;
      event.preventDefault();
      this.drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: this.x,
        startY: this.y,
      };
      stage.setPointerCapture(event.pointerId);
      stage.classList.add('is-dragging');
    });
    stage.addEventListener('pointermove', (event) => {
      if (!this.drag || this.drag.id !== event.pointerId) return;
      this.x = this.drag.startX + event.clientX - this.drag.x;
      this.y = this.drag.startY + event.clientY - this.drag.y;
      this.render();
    });
    const end = () => {
      this.drag = null;
      stage.classList.remove('is-dragging');
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('lostpointercapture', end);
    new ResizeObserver(() => this.render()).observe(stage);
  }
  reset(enabled = false) {
    this.enabled = enabled;
    this.zoom = 1;
    this.x = this.y = 0;
    this.drag = null;
    this.stage.classList.remove('is-dragging');
    this.render();
  }
  fitScale() {
    return Math.min(
      this.stage.clientWidth / (this.image.naturalWidth || 1),
      this.stage.clientHeight / (this.image.naturalHeight || 1),
      1,
    );
  }
  fit() {
    this.zoom = 1;
    this.x = this.y = 0;
    this.render();
  }
  actualPixels() {
    this.change(1 / this.fitScale());
  }
  change(value, anchorX = 0, anchorY = 0) {
    const next = Math.max(1, Math.min(Math.max(16, 4 / this.fitScale()), value));
    this.x = anchorX - ((anchorX - this.x) * next) / this.zoom;
    this.y = anchorY - ((anchorY - this.y) * next) / this.zoom;
    this.zoom = next;
    this.render();
  }
  render() {
    const ready = this.enabled && this.image.naturalWidth && !this.image.hidden;
    for (const id of ['viewer-zoom-in', 'viewer-zoom-out', 'viewer-fit', 'viewer-actual']) {
      const button = document.getElementById(id);
      if (button) button.disabled = !ready;
    }
    this.stage.classList.toggle('is-zoomed', Boolean(ready && this.zoom > 1));
    if (!ready) {
      this.image.style.cssText = '';
      return;
    }
    const scale = this.fitScale() * this.zoom;
    const width = this.image.naturalWidth * scale,
      height = this.image.naturalHeight * scale;
    const limitX = Math.max(0, (width - this.stage.clientWidth) / 2);
    const limitY = Math.max(0, (height - this.stage.clientHeight) / 2);
    this.x = Math.max(-limitX, Math.min(limitX, this.x));
    this.y = Math.max(-limitY, Math.min(limitY, this.y));
    Object.assign(this.image.style, {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(-50%, -50%) translate(${this.x}px, ${this.y}px)`,
    });
    document.getElementById('viewer-zoom-level').textContent = `${Math.round(scale * 100)}%`;
    document.getElementById('viewer-fit').setAttribute('aria-pressed', String(this.zoom === 1));
    document
      .getElementById('viewer-actual')
      .setAttribute('aria-pressed', String(Math.abs(scale - 1) < 0.001));
  }
}
window.PhotoZoom = PhotoZoom;
