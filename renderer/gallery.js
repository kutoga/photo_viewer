'use strict';
class VirtualGallery {
  constructor(scroll, space, onOpen, small = false) {
    this.scroll = scroll;
    this.space = space;
    this.onOpen = onOpen;
    this.small = small;
    this.targetSize = small ? 130 : 220;
    this.layoutMode = 'natural';
    this.dimensions = new Map();
    this.items = [];
    this.cards = new Map();
    this.frame = 0;
    scroll.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.observer = new ResizeObserver(() => {
      this.layout();
      this.schedule();
    });
    this.observer.observe(scroll);
    space.addEventListener('click', (e) => {
      const card = e.target.closest('[data-index]');
      if (card) this.onOpen(this.items, Number(card.dataset.index));
    });
    space.addEventListener('keydown', (e) => {
      const card = e.target.closest('[data-index]');
      if (!card || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -this.cols, ArrowDown: this.cols }[
        e.key
      ];
      const index = Math.max(0, Math.min(this.items.length - 1, Number(card.dataset.index) + step));
      const top = this.positions[index].top;
      if (
        top < this.scroll.scrollTop ||
        top + this.positions[index].height > this.scroll.scrollTop + this.scroll.clientHeight
      )
        this.scroll.scrollTop = top;
      this.render();
      this.cards.get(index)?.focus({ preventScroll: true });
    });
  }
  setItems(items, reset = true) {
    this.items = items;
    this.cards.clear();
    this.space.replaceChildren();
    if (reset) this.scroll.scrollTop = 0;
    this.layout();
    this.render();
  }
  setOptions(size, mode) {
    if (Number.isFinite(size)) this.targetSize = Math.max(150, Math.min(360, size));
    if (['grid', 'natural'].includes(mode)) this.layoutMode = mode;
    this.relayout();
  }
  relayout() {
    const anchor = [...this.cards.keys()].find(
      (index) => this.positions[index]?.top >= this.scroll.scrollTop,
    );
    const offset = anchor === undefined ? 0 : this.positions[anchor].top - this.scroll.scrollTop;
    this.layout();
    if (anchor !== undefined && this.positions[anchor])
      this.scroll.scrollTop = this.positions[anchor].top - offset;
    this.schedule();
  }
  layout() {
    const width = this.scroll.clientWidth;
    if (!width) return;
    this.padding = this.small ? 12 : 18;
    this.gap = this.small ? 9 : 16;
    this.cols = Math.max(1, Math.floor((width - this.padding * 2 + this.gap) / this.targetSize));
    this.cardWidth = (width - this.padding * 2 - this.gap * (this.cols - 1)) / this.cols;
    this.columns = Array.from({ length: this.cols }, () => []);
    const heights = Array(this.cols).fill(this.padding);
    this.positions = this.items.map((item, index) => {
      const col = index % this.cols;
      const ratio =
        this.dimensions.get(item.id) || item.thumbnailWidth / item.thumbnailHeight || 4 / 3;
      const pictureHeight =
        this.layoutMode === 'natural'
          ? this.cardWidth / Math.max(1 / 3, Math.min(4, ratio))
          : this.cardWidth * 0.75;
      const position = {
        left: this.padding + col * (this.cardWidth + this.gap),
        top: heights[col],
        height: Math.round(pictureHeight + 51),
      };
      heights[col] += position.height + this.gap;
      this.columns[col].push(index);
      return position;
    });
    this.space.style.height = `${Math.max(...heights) + this.padding}px`;
  }
  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }
  render() {
    if (!this.scroll.clientWidth || !this.positions) return;
    const top = this.scroll.scrollTop - 200;
    const bottom = this.scroll.scrollTop + this.scroll.clientHeight + 200;
    const visible = [];
    for (const column of this.columns) {
      let lo = 0,
        hi = column.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1,
          pos = this.positions[column[mid]];
        if (pos.top + pos.height < top) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < column.length && this.positions[column[i]].top < bottom; i++)
        visible.push(column[i]);
    }
    const wanted = new Set(visible);
    for (const [index, card] of this.cards)
      if (!wanted.has(index)) {
        card.remove();
        this.cards.delete(index);
      }
    for (const index of visible.sort((a, b) => a - b)) {
      const p = this.items[index];
      let card = this.cards.get(index);
      if (!card) {
        card = document.createElement('button');
        card.className = 'gallery-card';
        card.dataset.index = index;
        card.setAttribute('aria-label', `Open ${p.filename}`);
        const pic = document.createElement('div');
        pic.className = 'gallery-picture';
        if (p.hasThumbnail) {
          const img = document.createElement('img');
          img.src = PhotoModel.thumb(p);
          img.alt = '';
          img.loading = 'lazy';
          img.decoding = 'async';
          img.addEventListener(
            'load',
            () => {
              const ratio = img.naturalWidth / img.naturalHeight;
              if (!ratio || this.dimensions.get(p.id) === ratio) return;
              this.dimensions.set(p.id, ratio);
              if (!this.dimensionFrame)
                this.dimensionFrame = requestAnimationFrame(() => {
                  this.dimensionFrame = 0;
                  this.relayout();
                });
            },
            { once: true },
          );
          img.addEventListener(
            'error',
            () => {
              pic.innerHTML = `<span class="photo-fallback">${icon('image')}</span>`;
            },
            { once: true },
          );
          pic.append(img);
        } else
          pic.innerHTML = `<span class="photo-fallback">${icon(p.type === 'video' ? 'video' : 'image')}</span>`;
        if (p.type === 'video') {
          const badge = document.createElement('span');
          badge.className = 'pin-video';
          badge.innerHTML = icon('play');
          pic.append(badge);
        }
        const caption = document.createElement('div');
        caption.className = 'gallery-card-caption';
        const name = document.createElement('span');
        name.className = 'gallery-card-name';
        name.textContent = p.filename;
        const date = document.createElement('span');
        date.className = 'gallery-card-date';
        date.textContent = p.date
          ? new Date(p.date).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
          : 'Date unknown';
        caption.append(name, date);
        card.append(pic, caption);
        this.space.append(card);
        this.cards.set(index, card);
      }
      Object.assign(card.style, {
        left: `${this.positions[index].left}px`,
        top: `${this.positions[index].top}px`,
        width: `${this.cardWidth}px`,
        height: `${this.positions[index].height}px`,
      });
    }
  }
}
window.VirtualGallery = VirtualGallery;
