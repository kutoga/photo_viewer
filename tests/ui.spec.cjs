const { test, expect } = require('@playwright/test');
const path = require('node:path');
async function setup(page, size = 180, tiles = false, needsRescan = false) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  if (!tiles)
    await page.route('https://*.arcgisonline.com/**', (route) =>
      route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQIHWP4DwQACfsD/fteaysAAAAASUVORK5CYII=',
          'base64',
        ),
      }),
    );
  await page.addInitScript(
    ({ size, needsRescan }) => {
      const positions = [
        [46.6863, 7.8632],
        [46.6242, 8.0414],
        [46.577, 8.005],
        [47.3769, 8.5417],
        [46.0207, 7.7491],
        [46.452, 6.8499],
      ];
      const names = [
        'Morning in the mountains',
        'A quiet afternoon',
        'On the trail',
        'By the water',
        'The long way home',
        'Summer days',
      ];
      const items = Array.from({ length: size }, (_, i) => ({
        id: i.toString(16).padStart(32, '0'),
        lat: positions[i % 6][0] + (i % 11) * 0.003,
        lng: positions[i % 6][1] + (i % 7) * 0.003,
        date: new Date(Date.UTC(2024 + (i % 3), i % 12, 1 + (i % 27), 12)).toISOString(),
        filename: names[i % 6] + ' ' + i + (i % 5 === 0 ? '.mp4' : '.jpg'),
        originalPath:
          '/Pictures/Switzerland/' + names[i % 6] + ' ' + i + (i % 5 === 0 ? '.mp4' : '.jpg'),
        type: i % 5 === 0 ? 'video' : 'photo',
        hasThumbnail: true,
        thumbnailUrl: '/fixture/' + i,
        fileMtime: 1,
      }));
      const snapshot = {
        needsRescan,
        items,
        folders: size ? [{ path: '/Pictures/Switzerland', name: 'Switzerland', count: size }] : [],
        summary: {
          total: size,
          located: size,
          withoutGPS: 0,
          photos: size * 0.8,
          videos: size * 0.2,
        },
      };
      const events = {};
      window.__events = events;
      window.__snapshot = snapshot;
      window.photoMap = {
        getLibrary: async () => snapshot,
        addFolders: async () => {
          snapshot.folders = [{ path: '/Pictures/Switzerland', name: 'Switzerland', count: 0 }];
          return snapshot;
        },
        removeFolder: async () => ({
          items: [],
          folders: [],
          summary: { total: 0, located: 0, withoutGPS: 0 },
        }),
        startScan: async () => {
          events.progress?.({
            processed: 10,
            discovered: 10,
            added: 2,
            currentFile: 'A new memory.jpg',
          });
        },
        cancelScan: async () =>
          events.complete?.({
            phase: 'cancelled',
            summary: snapshot.summary,
            folders: snapshot.folders,
            skipped: 0,
            added: 0,
            errors: 0,
          }),
        getPreview: async (id) => ({ image: '/fixture/' + parseInt(id, 16), video: null }),
        reveal: async () => {},
        openOriginal: async () => {},
        openMaps: async () => {},
        onChanges: (fn) => {
          events.changes = fn;
        },
        onProgress: (fn) => {
          events.progress = fn;
        },
        onComplete: (fn) => {
          events.complete = fn;
        },
        onError: (fn) => {
          events.error = fn;
        },
      };
    },
    { size, needsRescan },
  );
  await page.goto('/renderer/index.html');
  await expect(page.locator('#located-total')).toHaveText(size.toLocaleString());
  await page.waitForFunction(() => typeof atlas !== 'undefined' && !atlas.loadBusy);
  return errors;
}
test('clear first-run experience, folder picker flow, scan cancellation and visible errors', async ({
  page,
}) => {
  const errors = await setup(page, 0);
  await expect(page.getByText('Your next journey starts here.')).toBeVisible();
  await page.screenshot({ path: 'test-results/empty-state.png' });
  await page.getByRole('button', { name: 'Choose your first folder' }).click();
  await expect(page.locator('#scan-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add photos', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Stop scan' }).click();
  await expect(page.locator('#scan-panel')).toBeHidden();
  await expect(page.locator('#status-text')).toContainText('Progress saved');
  await page.evaluate(() => window.__events.error('The drive is not available'));
  await expect(page.getByRole('alert')).toContainText('The drive is not available');
  expect(errors).toEqual([]);
});
test('map, media filter, empty heatmap, date range, live updates and reset', async ({ page }) => {
  const errors = await setup(page);
  await page.locator('[data-type="video"]').click();
  await expect(page.locator('#visible-count')).toHaveText('36');
  await page.locator('#date-from').fill('2026-01-01');
  await page.locator('#date-from').dispatchEvent('change');
  await expect(page.locator('#visible-count')).toHaveText('12');
  await page.locator('#reset-filters').click();
  await page.evaluate(() => atlas.map.setZoom(3));
  await expect.poll(() => page.evaluate(() => atlas.map.hasLayer(atlas.heat))).toBe(true);
  await page.locator('#search').fill('does-not-exist');
  await expect(page.locator('#visible-count')).toHaveText('0');
  await expect.poll(() => page.evaluate(() => atlas.map.hasLayer(atlas.heat))).toBe(false);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.evaluate(() =>
    window.__events.changes({
      upsert: [
        {
          ...window.__snapshot.items[1],
          id: 'ffffffffffffffffffffffffffffffff',
          lat: 0,
          lng: 0,
          date: '2030-01-01T12:00:00Z',
        },
      ],
      remove: [],
    }),
  );
  await expect(page.locator('#visible-count')).toHaveText('181');
  await expect(page.locator('#date-to')).toHaveValue('2030-01-01');
  expect(errors).toEqual([]);
});
test('large gallery is virtualized and viewer navigation is stable during live updates', async ({
  page,
}) => {
  const errors = await setup(page, 10000);
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await expect(page.locator('#gallery-scroll .gallery-card').first()).toBeVisible();
  expect(await page.locator('#gallery-scroll .gallery-card').count()).toBeLessThan(60);
  await page.locator('#gallery-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator('#gallery-scroll [data-index="9999"]')).toBeVisible();
  await page.locator('#gallery-scroll [data-index="9999"]').click();
  await expect(page.locator('#lightbox')).toBeVisible();
  await expect(page.locator('#viewer-position')).toContainText('10000 / 10,000');
  const filename = await page.locator('#viewer-name').textContent();
  await page.evaluate(() =>
    window.__events.changes({
      upsert: [{ ...window.__snapshot.items[1], id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }],
      remove: [],
    }),
  );
  await expect(page.locator('#visible-count')).toHaveText('10,001');
  await expect(page.locator('#viewer-name')).toHaveText(filename);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#viewer-position')).toContainText('1 / 10,000');
  await page.keyboard.press('Escape');
  await expect(page.locator('#lightbox')).toBeHidden();
  expect(errors).toEqual([]);
});
test('cluster browsing, gallery, dialogs and compact window layout', async ({ page }) => {
  const errors = await setup(page);
  await expect(page.locator('.cluster-pin').first()).toBeVisible();
  await page.locator('.cluster-pin').first().click();
  await expect(page.locator('#area-panel')).toBeVisible();
  await page.locator('#area-close').click();
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.screenshot({ path: 'test-results/gallery.png' });
  await page.locator('#gallery-scroll .gallery-card').first().click();
  await expect(page.locator('#viewer-loading')).toBeHidden();
  await page.screenshot({ path: 'test-results/viewer.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Help & shortcuts' }).click();
  await expect(page.locator('#help-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Remove folder Switzerland', exact: true }).click();
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep folder' }).click();
  await page.setViewportSize({ width: 900, height: 640 });
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('#timeline')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/compact.png' });
  expect(errors).toEqual([]);
});
test('map visual review at desktop size', async ({ page }) => {
  const errors = await setup(page, 180, true);
  // Allow imagery to arrive; no behavior assertion depends on the remote service.
  await page.waitForTimeout(1800);
  await page.screenshot({ path: 'test-results/map.png' });
  expect(errors).toEqual([]);
});

test('cluster near the map edge opens with one physical click', async ({ page }) => {
  const errors = await setup(page);
  await page.evaluate(() => {
    atlas.map.setView([47.4, 9.6], 12, { animate: false });
    const position = atlas.map.containerPointToLatLng([6, 200]);
    atlas.setItems(
      window.__snapshot.items
        .slice(0, 3)
        .map((p) => ({ ...p, lat: position.lat, lng: position.lng })),
    );
  });
  await expect(page.locator('.cluster-pin')).toHaveCount(1);
  const center = await page.locator('.cluster-pin').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(center.x, center.y);
  await expect(page.locator('#area-panel')).toBeVisible();
  await expect(page.locator('#area-count')).toHaveText('3 memories to rediscover');
  expect(errors).toEqual([]);
});

test('a visible cluster keeps its own members while a newer index is loading', async ({ page }) => {
  const errors = await setup(page);
  const expected = await page.evaluate(async () => {
    const marker = [...atlas.markers.entries()].find(([key]) => key.startsWith('c'))[1];
    const count = Number(marker.getElement().textContent);
    // Hold the displayed markers while a new index containing different clusters is built.
    atlas.query = () => {};
    atlas.setItems(window.__snapshot.items.slice(0, 6));
    await new Promise((resolve) => {
      const poll = () => (atlas.loadBusy ? setTimeout(poll, 10) : resolve());
      poll();
    });
    marker.fire('click');
    return count;
  });
  await expect(page.locator('#area-panel')).toBeVisible();
  await expect(page.locator('#area-count')).toHaveText(`${expected} memories to rediscover`);
  expect(errors).toEqual([]);
});

test('fullscreen map uses the entire window and exits with its button, Escape, and F11', async ({
  page,
}) => {
  const errors = await setup(page);
  await page.getByRole('button', { name: 'Fullscreen map', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const rect = document.getElementById('map').getBoundingClientRect();
        return (
          Math.round(rect.width) === innerWidth &&
          Math.round(rect.height) === innerHeight &&
          rect.x === 0 &&
          rect.y === 0
        );
      }),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Browse this area' }).click();
  await page.locator('#area-scroll .gallery-card').first().click();
  await expect(page.locator('#lightbox')).toBeVisible();
  await page.getByRole('button', { name: 'Close viewer', exact: true }).click();
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.keyboard.press('F11');
  await expect(page.locator('body')).toHaveClass(/map-fullscreen/);
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/map-fullscreen/);
  await page.keyboard.press('F11');
  await expect(page.locator('body')).toHaveClass(/map-fullscreen/);
  await page.keyboard.press('F11');
  await expect(page.locator('.sidebar')).toBeVisible();
  expect(errors).toEqual([]);
});

test('library sorting stays off the UI thread and map rebuilding pauses in gallery during import', async ({
  page,
}) => {
  const errors = await setup(page, 50000);
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  const version = await page.evaluate(() => atlas.version);
  await page.evaluate(() => {
    // Regression guard: bulk library operations must execute in the worker, not this thread.
    PhotoModel.filter =
      PhotoModel.sort =
      PhotoModel.dateBounds =
        () => {
          throw new Error('Bulk library work ran on the UI thread');
        };
    window.__events.progress({ processed: 50000, added: 0 });
    window.__batch = 0;
    window.__import = setInterval(() => {
      const batch = ++window.__batch;
      window.__events.changes({
        upsert: Array.from({ length: 100 }, (_, i) => ({
          ...window.__snapshot.items[i],
          id: (50000 + batch * 100 + i).toString(16).padStart(32, '0'),
        })),
        remove: [],
      });
    }, 100);
  });
  await page.locator('#search').fill('Summer days');
  await expect(page.locator('#visible-count')).not.toHaveText('50,000');
  await page.locator('#gallery-scroll .gallery-card').first().click();
  await expect(page.locator('#lightbox')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#viewer-position')).toContainText('2 /');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Stop scan' }).click();
  await page.evaluate(() => clearInterval(window.__import));
  await expect(page.locator('#scan-panel')).toBeHidden();
  expect(await page.evaluate(() => atlas.version)).toBe(version);
  expect(await page.locator('#gallery-scroll .gallery-card').count()).toBeLessThan(60);
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect.poll(() => page.evaluate(() => atlas.version)).toBeGreaterThan(version);
  expect(errors).toEqual([]);
});

test('map display override works at every zoom and Auto restores zoom switching', async ({
  page,
}) => {
  const errors = await setup(page);
  await expect(page.locator('[data-map-mode="auto"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-map-mode="heat"]').click();
  await page.evaluate(() => atlas.map.setZoom(15, { animate: false }));
  await expect.poll(() => page.evaluate(() => atlas.map.hasLayer(atlas.heat))).toBe(true);
  await expect(page.locator('.cluster-pin')).toHaveCount(0);
  await page.locator('[data-map-mode="bubbles"]').click();
  await page.evaluate(() => atlas.map.setView([47, 8], 3, { animate: false }));
  await expect.poll(() => page.evaluate(() => atlas.map.hasLayer(atlas.heat))).toBe(false);
  await expect(page.locator('.cluster-pin').first()).toBeVisible();
  await page.locator('.cluster-pin').first().click();
  await expect(page.locator('#area-panel')).toBeVisible();
  await page.locator('#area-close').click();
  // A single photo remains a numbered bubble even beyond cluster zoom levels.
  await page.evaluate(() => {
    const p = window.__snapshot.items[0];
    atlas.setItems([p]);
    atlas.map.setView([p.lat, p.lng], 20, { animate: false });
  });
  await expect(page.locator('.cluster-pin')).toHaveText('1');
  await page.locator('.cluster-pin').click();
  await expect(page.locator('#lightbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('[data-map-mode="auto"]').click();
  await expect(page.locator('.photo-pin')).toHaveCount(1);
  await page.evaluate(() => atlas.map.setZoom(3, { animate: false }));
  await expect.poll(() => page.evaluate(() => atlas.map.hasLayer(atlas.heat))).toBe(true);
  expect(errors).toEqual([]);
});

test('view dates use the map viewport, an area selection, and gallery results', async ({
  page,
}) => {
  const errors = await setup(page);
  const expected = await page.evaluate(() => {
    atlas.map.setView([46.69, 7.87], 12, { animate: false });
    return PhotoModel.dateBounds(
      state.filtered.filter((p) => PhotoModel.inBounds(p, atlas.bounds())),
    );
  });
  await page.locator('#use-view-dates').click();
  await expect(page.locator('#date-from')).toHaveValue(expected.min);
  await expect(page.locator('#date-to')).toHaveValue(expected.max);
  await page.locator('#date-reset').click();
  await expect(page.locator('#visible-count')).toHaveText('180');
  await page.evaluate(() => showArea([window.__snapshot.items[1]], 'Selected trip'));
  await page.locator('#area-use-dates').click();
  await expect(page.locator('#date-from')).toHaveValue('2025-02-02');
  await expect(page.locator('#date-to')).toHaveValue('2025-02-02');
  await expect(page.locator('#area-panel')).toBeHidden();
  await page.locator('#date-reset').click();
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.locator('#search').fill('A quiet afternoon');
  await expect(page.locator('#visible-count')).toHaveText('30');
  const galleryDates = await page.evaluate(() => PhotoModel.dateBounds(state.filtered));
  await page.locator('#use-view-dates').click();
  await expect(page.locator('#date-from')).toHaveValue(galleryDates.min);
  await expect(page.locator('#date-to')).toHaveValue(galleryDates.max);
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await page.evaluate(() => atlas.map.setView([-60, -140], 12, { animate: false }));
  await expect(page.locator('#use-view-dates')).toBeDisabled();
  await page.evaluate(() => showArea([{ ...window.__snapshot.items[1], date: null }]));
  await expect(page.locator('#area-use-dates')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('normal map is spacious, sidebar collapses, and search restores access to filters', async ({
  page,
}) => {
  const errors = await setup(page);
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 900, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    const map = await page.locator('#map').boundingBox();
    expect(map.height).toBeGreaterThan(viewport.height * 0.75);
    expect(map.width).toBeGreaterThan(viewport.width * 0.73);
    const toolbar = await page.locator('.map-toolbar').boundingBox();
    expect(toolbar.x + toolbar.width).toBeLessThan(map.x + map.width);
    await page.getByRole('button', { name: 'Hide library and filters' }).click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect
      .poll(async () => (await page.locator('#map').boundingBox()).width)
      .toBeGreaterThan(viewport.width * 0.95);
    await page.keyboard.press('/');
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('#search')).toBeFocused();
    await page.locator('#sidebar-toggle').focus();
  }
  expect(errors).toEqual([]);
});

test('gallery and area thumbnails contain the complete portrait and panoramic images', async ({
  page,
}) => {
  await page.route('**/fixture/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="320"><rect width="160" height="320" fill="#48785e"/><rect x="4" y="4" width="152" height="312" fill="none" stroke="white" stroke-width="8"/></svg>',
    }),
  );
  const errors = await setup(page);
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  const picture = page.locator('#gallery-scroll .gallery-picture img').first();
  await expect
    .poll(() => picture.evaluate((img) => img.naturalWidth / img.naturalHeight))
    .toBe(0.5);
  await expect(picture).toHaveCSS('object-fit', 'contain');
  await picture.hover();
  await expect(picture).toHaveCSS('transform', 'none');
  await page.screenshot({ path: 'test-results/portrait-gallery.png' });
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await page.locator('#browse-area').click();
  await expect(page.locator('#area-scroll .gallery-picture img').first()).toHaveCSS(
    'object-fit',
    'contain',
  );
  expect(errors).toEqual([]);
});

test('startup automatically refreshes a catalog flagged as obsolete', async ({ page }) => {
  const errors = await setup(page, 180, false, true);
  await expect(page.locator('#scan-panel')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('Refreshing older thumbnails');
  await expect(page.locator('#visible-count')).toHaveText('180');
  await page.getByRole('button', { name: 'Stop scan' }).click();
  await expect(page.locator('#scan-panel')).toBeHidden();
  expect(errors).toEqual([]);
});

test('viewer side previews follow clicks, keyboard navigation and wraparound without loading full previews', async ({
  page,
}) => {
  const errors = await setup(page);
  await page.evaluate(() => {
    const getPreview = window.photoMap.getPreview;
    window.__previewRequests = [];
    window.photoMap.getPreview = (id) => {
      window.__previewRequests.push(id);
      return getPreview(id);
    };
    openViewer(window.__snapshot.items.slice(0, 3), 1);
  });
  const previous = page.locator('#viewer-prev-preview img');
  const next = page.locator('#viewer-next-preview img');
  await expect(previous).toHaveAttribute('src', '/fixture/0');
  await expect(next).toHaveAttribute('src', '/fixture/2');
  await expect(previous).toHaveCSS('object-fit', 'contain');
  await expect(page.locator('#viewer-prev-preview .viewer-neighbor-video')).toBeVisible();
  await expect(page.locator('#viewer-loading')).toBeHidden();
  expect(await page.evaluate(() => window.__previewRequests)).toEqual([
    '00000000000000000000000000000001',
  ]);
  await page.getByRole('button', { name: 'Next photo', exact: true }).click();
  await expect(page.locator('#viewer-position')).toContainText('3 / 3');
  await expect(previous).toHaveAttribute('src', '/fixture/1');
  await expect(next).toHaveAttribute('src', '/fixture/0');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#viewer-position')).toContainText('1 / 3');
  await expect(previous).toHaveAttribute('src', '/fixture/2');
  await expect(next).toHaveAttribute('src', '/fixture/1');
  await page.getByRole('button', { name: 'Previous photo', exact: true }).click();
  await expect(page.locator('#viewer-position')).toContainText('3 / 3');
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 900, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(previous).toBeInViewport();
    await expect(next).toBeInViewport();
    const prevBox = await page.locator('#viewer-prev').boundingBox();
    const stageBox = await page.locator('.viewer-stage').boundingBox();
    const nextBox = await page.locator('#viewer-next').boundingBox();
    expect(prevBox.x + prevBox.width).toBeLessThanOrEqual(stageBox.x);
    expect(stageBox.x + stageBox.width).toBeLessThanOrEqual(nextBox.x);
    expect(stageBox.width).toBeGreaterThan(viewport.width * 0.6);
    await page.screenshot({ path: `test-results/viewer-neighbors-${viewport.width}.png` });
  }
  expect(errors).toEqual([]);
});

test('viewer side previews handle missing thumbnails and single-photo selections', async ({
  page,
}) => {
  const errors = await setup(page);
  await page.route('**/fixture/missing', (route) => route.fulfill({ status: 404, body: '' }));
  await page.evaluate(() => {
    const items = window.__snapshot.items.slice(0, 3);
    openViewer(
      [
        { ...items[0], hasThumbnail: false },
        items[1],
        { ...items[2], thumbnailUrl: '/fixture/missing' },
      ],
      1,
    );
  });
  await expect(page.locator('#viewer-prev-preview .viewer-neighbor-fallback')).toBeVisible();
  await expect(page.locator('#viewer-next-preview img')).toHaveCount(0);
  await expect(page.locator('#viewer-next-preview .viewer-neighbor-fallback')).toBeVisible();
  await page.getByRole('button', { name: 'Next photo', exact: true }).click();
  await expect(page.locator('#viewer-position')).toContainText('3 / 3');
  await page.keyboard.press('Escape');
  await page.evaluate(() => openViewer(window.__snapshot.items.slice(0, 1), 0));
  await expect(page.locator('#viewer-prev')).toBeHidden();
  await expect(page.locator('#viewer-next')).toBeHidden();
  expect(errors).toEqual([]);
});

test('neighbors are prefetched once and navigation reuses decoded previews', async ({ page }) => {
  const errors = await setup(page);
  await page.evaluate(() => {
    const original = window.photoMap.getPreview;
    window.__loads = [];
    window.photoMap.getPreview = async (id, options) => {
      window.__loads.push({ id, prefetch: Boolean(options?.prefetch) });
      return original(id);
    };
    openViewer(window.__snapshot.items.slice(1, 4), 1);
  });
  await expect.poll(() => page.evaluate(() => window.__loads.length)).toBe(3);
  expect(await page.evaluate(() => window.__loads.map((p) => p.prefetch))).toEqual([
    false,
    true,
    true,
  ]);
  await page.getByRole('button', { name: 'Next photo', exact: true }).click();
  await expect(page.locator('#viewer-loading')).toBeHidden();
  await expect(page.locator('#viewer-position')).toContainText('3 / 3');
  expect(await page.evaluate(() => window.__loads.length)).toBe(3);
  expect(await page.evaluate(() => previewCache.entries.size)).toBeLessThanOrEqual(5);
  expect(errors).toEqual([]);
});

test('photo zoom loads actual resolution, pans, fits and resets when navigating', async ({
  page,
}) => {
  const errors = await setup(page);
  await page.route('**/fixture/full', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="2000"><rect width="3000" height="2000" fill="#638575"/></svg>',
    }),
  );
  await page.evaluate(() => {
    const original = window.photoMap.getPreview;
    window.photoMap.getPreview = (id, options) =>
      options?.full ? Promise.resolve({ image: '/fixture/full', video: null }) : original(id);
    openViewer(window.__snapshot.items.slice(1, 4), 0);
  });
  await expect(page.locator('#viewer-loading')).toBeHidden();
  await page.locator('#viewer-actual').click();
  await expect(page.locator('#viewer-zoom-level')).toHaveText('100%');
  await expect
    .poll(() => page.locator('#viewer-image').evaluate((img) => img.naturalWidth))
    .toBe(3000);
  await expect(page.locator('#viewer-image')).toHaveCSS('width', '3000px');
  const stage = await page.locator('.viewer-stage').boundingBox();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2 + 100, stage.y + stage.height / 2 + 60);
  await page.mouse.up();
  expect(await page.evaluate(() => photoZoom.x)).toBeCloseTo(100, 0);
  await page.locator('#viewer-fit').click();
  expect(await page.evaluate(() => photoZoom.zoom)).toBe(1);
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => page.evaluate(() => photoZoom.zoom)).toBeGreaterThan(1);
  await page.locator('.viewer-stage').dblclick();
  expect(await page.evaluate(() => photoZoom.zoom)).toBe(1);
  await page.locator('.viewer-stage').dblclick();
  await expect(page.locator('#viewer-zoom-level')).toHaveText('100%');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#viewer-position')).toContainText('2 / 3');
  expect(await page.evaluate(() => photoZoom.zoom)).toBe(1);
  expect(errors).toEqual([]);
});

test('workspace restores map, display, sidebar and gallery preferences after reload', async ({
  page,
}) => {
  const errors = await setup(page);
  await page.evaluate(() => atlas.map.setView([48.25, 9.5], 10, { animate: false }));
  await page.locator('[data-map-mode="bubbles"]').click();
  await page.locator('#show-labels').uncheck();
  await page.locator('#sidebar-toggle').click();
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.locator('#gallery-size').fill('300');
  await page.locator('#gallery-layout').selectOption('grid');
  await page.locator('#sort-order').selectOption('oldest');
  await page.reload();
  await expect(page.locator('#visible-count')).toHaveText('180');
  await expect(page.locator('#gallery-view')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('#gallery-size')).toHaveValue('300');
  await expect(page.locator('#gallery-layout')).toHaveValue('grid');
  await expect(page.locator('#sort-order')).toHaveValue('oldest');
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('[data-map-mode="bubbles"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#show-labels')).not.toBeChecked();
  expect(await page.evaluate(() => atlas.map.getZoom())).toBe(10);
  const center = await page.evaluate(() => atlas.map.getCenter());
  expect(center.lat).toBeCloseTo(48.25, 1);
  expect(center.lng).toBeCloseTo(9.5, 1);
  expect(errors).toEqual([]);
});

test('monthly histogram selects a month and keeps other months available for comparison', async ({
  page,
}) => {
  const errors = await setup(page);
  const february = page.locator('[data-month="2025-02"]');
  await expect(february).toHaveAttribute('aria-label', 'February 2025: 15 photos');
  await february.click();
  await expect(page.locator('#date-from')).toHaveValue('2025-02-01');
  await expect(page.locator('#date-to')).toHaveValue('2025-02-28');
  await expect(page.locator('#visible-count')).toHaveText('15');
  await expect(page.locator('[data-month="2026-03"]')).toHaveAttribute(
    'aria-label',
    'March 2026: 15 photos',
  );
  await page.locator('[data-type="video"]').click();
  await expect(page.locator('#visible-count')).toHaveText('3');
  await expect(february).toHaveAttribute('aria-label', 'February 2025: 3 photos');
  await page.locator('#date-reset').click();
  await expect(page.locator('#visible-count')).toHaveText('36');
  expect(errors).toEqual([]);
});

test('natural gallery gives portraits more height, supports resizing and retains virtual navigation', async ({
  page,
}) => {
  await page.route('**/fixture/**', (route) => {
    const portrait = Number(route.request().url().split('/').pop()) % 2 === 0;
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${portrait ? 160 : 320}" height="${portrait ? 320 : 160}"><rect width="100%" height="100%" fill="#648575"/></svg>`,
    });
  });
  const errors = await setup(page);
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.evaluate(() => gallery.setItems(window.__snapshot.items.slice(0, 12)));
  const portrait = page.locator('#gallery-scroll [data-index="0"]');
  const landscape = page.locator('#gallery-scroll [data-index="1"]');
  await expect
    .poll(
      async () => (await portrait.boundingBox()).height / (await landscape.boundingBox()).height,
    )
    .toBeGreaterThan(2);
  const before = (await portrait.boundingBox()).width;
  await page.locator('#gallery-size').fill('340');
  await expect.poll(async () => (await portrait.boundingBox()).width).toBeGreaterThan(before);
  await page.locator('#gallery-layout').selectOption('grid');
  expect((await portrait.boundingBox()).height).toBe((await landscape.boundingBox()).height);
  await page.locator('#gallery-layout').selectOption('natural');
  await portrait.focus();
  await page.keyboard.press('ArrowDown');
  const columnCount = await page.evaluate(() => gallery.cols);
  await expect(page.locator(`#gallery-scroll [data-index="${columnCount}"]`)).toBeFocused();
  await page.screenshot({ path: 'test-results/gallery-natural.png' });
  expect(errors).toEqual([]);
});
