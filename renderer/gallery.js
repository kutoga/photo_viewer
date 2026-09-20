'use strict';
class VirtualGallery {
  constructor(scroll, space, onOpen, small = false) {
    this.scroll = scroll;
    this.space = space;
    this.onOpen = onOpen;
    this.small = small;
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
      const top = Math.floor(index / this.cols) * this.rowHeight;
      if (
        top < this.scroll.scrollTop ||
        top + this.rowHeight > this.scroll.scrollTop + this.scroll.clientHeight
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
  layout() {
    const width = this.scroll.clientWidth;
    this.padding = this.small ? 12 : 18;
    this.gap = this.small ? 9 : 16;
    this.cols = Math.max(
      1,
      Math.floor((width - this.padding * 2 + this.gap) / (this.small ? 130 : 195)),
    );
    this.cardWidth = (width - this.padding * 2 - this.gap * (this.cols - 1)) / this.cols;
    this.rowHeight = Math.round(this.cardWidth * 0.75 + 51 + this.gap);
    this.space.style.height = `${Math.ceil(this.items.length / this.cols) * this.rowHeight + this.padding * 2}px`;
  }
  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }
  render() {
    if (!this.scroll.clientWidth || !this.rowHeight) return;
    const first =
      Math.max(0, Math.floor((this.scroll.scrollTop - this.padding) / this.rowHeight) - 1) *
      this.cols;
    const end = Math.min(
      this.items.length,
      (Math.ceil((this.scroll.scrollTop + this.scroll.clientHeight) / this.rowHeight) + 1) *
        this.cols,
    );
    // Keep only visible rows and a single row of overscan in the DOM.
    for (const [index, card] of this.cards)
      if (index < first || index >= end) {
        card.remove();
        this.cards.delete(index);
      }
    for (let index = first; index < end; index++) {
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
        left: `${this.padding + (index % this.cols) * (this.cardWidth + this.gap)}px`,
        top: `${this.padding + Math.floor(index / this.cols) * this.rowHeight}px`,
        width: `${this.cardWidth}px`,
        height: `${this.rowHeight - this.gap}px`,
      });
    }
  }
}
window.VirtualGallery = VirtualGallery;
