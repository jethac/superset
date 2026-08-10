/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Drill to detail: the modal reached from a chart's context menu or its
 * "More Options" menu, and the sample rows it shows for the clicked datum.
 *
 * Ported from cypress-base/cypress/e2e/dashboard/drilltodetail.test.ts, which
 * drove a fixture dashboard (`supported_charts_dash`) that only exists in the
 * test-data load. Each test here builds the chart it needs through the API
 * instead, so the suite runs against a plain `superset load_examples` database.
 */
import type { Locator, Page } from '@playwright/test';
import { testWithAssets, expect } from '../../helpers/fixtures';
import { DashboardPage } from '../../pages/DashboardPage';
import { TIMEOUT } from '../../utils/constants';
import {
  createDashboardWithCharts,
  type DashboardChartSpec,
} from './dashboard-test-helpers';

const DATASET_NAME = 'birth_names';

// Every test builds a dashboard through the API, waits for a chart to query and
// paint, then drives several context-menu round trips through the samples
// endpoint, which does not fit the default test timeout. The viz-type tests
// drill three times over, and search the chart for a datum before each one.
testWithAssets.beforeEach(() => {
  testWithAssets.setTimeout(TIMEOUT.SLOW_TEST * 8);
});

/** Rows in the `birth_names` example dataset. */
const ALL_ROWS = '75.7k rows';

/** Rows in `birth_names` for gender = boy. */
const BOY_ROWS = '39.2k rows';

/** Last page of the unfiltered sample set, at the modal's page size. */
const ALL_LAST_PAGE = '1514';

/** Last page of the boy-filtered sample set. */
const BOY_LAST_PAGE = '785';

const SELECTORS = {
  OPEN_DROPDOWN: '.ant-dropdown:not(.ant-dropdown-hidden)',
  MENU_ITEM: '[role="menu"] [role="menuitem"]',
  SUBMENU: '.ant-dropdown-menu-submenu-popup:visible',
  MODAL: '[role="dialog"]',
  MODAL_MASK: '.ant-modal-mask',
  MODAL_TITLE: '.draggable-trigger',
  CLOSE_MODAL: '[data-test="close-drilltodetail-modal"]',
  FILTER_COL: '[data-test="filter-col"]',
  FILTER_VAL: '[data-test="filter-val"]',
  ROW_COUNT: '[data-test="row-count-label"]',
  PAGINATION_ITEM: '.ant-pagination-item',
  PAGINATION_ACTIVE: '.ant-pagination-item-active',
  VIRTUAL_CELL: '.virtual-table-cell',
  VIRTUAL_GRID: '.virtual-grid',
  METADATA_BAR: '[data-test="metadata-bar"]',
} as const;

/** The samples endpoint every drill-to-detail query goes through. */
const SAMPLES_URL = /\/datasource\/samples/;

/**
 * Position of "Drill to detail" in a chart's "More Options" menu. Asserted
 * rather than assumed, mirroring the Cypress spec, so a reordering of that menu
 * is caught here rather than silently changing what the test clicks.
 */
const DRILL_MENU_INDEX = 5;

/** Escapes a drill label for use in an exact-match regular expression. */
const exactly = (text: string) =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

interface Point {
  x: number;
  y: number;
}

/**
 * Candidate points probed per chart before the search gives up.
 *
 * The Cypress spec right-clicked hard-coded pixel offsets tuned to one fixture
 * dashboard's cell sizes. Those offsets do not survive a different layout, so
 * the port asks each chart where it drew its marks and right-clicks those until
 * the context menu offers the drill the test is about. What is asserted is
 * unchanged — that a datum of the chart drills to the expected filter.
 */
const MAX_PROBES = 56;

/**
 * Candidates taken in weight order before the search starts spreading out over
 * the chart. Enough to cover a chart whose marks are all one shape.
 */
const WEIGHTED_PROBES = 4;

/**
 * How long a probe waits for a submenu before moving to the next candidate.
 * Shorter than the UI-transition ceiling because a probe that lands beside a
 * datum has nothing to wait for.
 */
const PROBE_TIMEOUT = 1000;

/** Moves the pointer is walked to a mark in, so the chart tracks its arrival. */
const POINTER_STEPS = 8;

/** Right-clicks attempted before a chart is taken to offer no context menu. */
const RIGHT_CLICK_ATTEMPTS = 3;

/** Hovers attempted before a submenu is taken to be unavailable. */
const SUBMENU_HOVER_ATTEMPTS = 3;

/** Nesting depth of the chart context menu, each level dismissed separately. */
const MENU_LEVELS = 2;

/** Grace period, in milliseconds, allowed for a dismissed menu to settle. */
const MENU_SETTLE = 500;

/**
 * Minimum spread between a shape's RGB channels for it to count as series
 * colour. Axes, gridlines and labels are drawn in greys, whose channels are
 * within a few units of each other.
 */
const COLOUR_SATURATION = 40;

/**
 * Minimum distance, in CSS pixels, between two candidate marks. Roughly the
 * width of an enlarged symbol, so that one mark yields few candidates.
 */
const MARK_SPACING = 12;

/** Divisions per axis of the grid of positions probed behind a chart's marks. */
const CHART_GRID = 6;

function chartOf(page: Page, vizType: string): Locator {
  return page.locator(`[data-test-viz-type='${vizType}']`);
}

/**
 * Dismisses an open context menu, and its drill-by submenu with it. Escape
 * closes one level of menu at a time, and a menu left open swallows the next
 * right-click aimed at the chart underneath it.
 */
async function closeContextMenu(page: Page): Promise<void> {
  for (let level = 0; level < MENU_LEVELS; level += 1) {
    await page.keyboard.press('Escape');
  }
  // A chart reports no datum for a right-click that arrives before it has been
  // told its own menu closed, and that is a state change no locator sees.
  await page.waitForTimeout(MENU_SETTLE);
}

/**
 * Closes the drill-to-detail modal if one is open, and waits for its backdrop
 * to go with it: a backdrop still fading out swallows clicks aimed at the chart
 * behind it.
 */
async function closeModal(page: Page): Promise<void> {
  const closeButton = page.locator(SELECTORS.CLOSE_MODAL);
  if (await closeButton.isVisible()) {
    await closeButton.click();
    await closeButton.waitFor({ state: 'hidden' });
  }
  await page
    .locator(SELECTORS.MODAL_MASK)
    .waitFor({ state: 'hidden', timeout: TIMEOUT.UI_TRANSITION })
    .catch(() => {
      // No backdrop is the desired state either way.
    });
  await page.waitForTimeout(MENU_SETTLE);
}

/**
 * The open chart context menu, identified by its unfiltered "Drill to detail"
 * entry so that the drill-by submenu — a dropdown in its own right — is never
 * mistaken for it.
 */
function contextMenu(page: Page): Locator {
  return page
    .locator(SELECTORS.OPEN_DROPDOWN)
    .filter({
      has: page
        .locator('[role="menuitem"]')
        .filter({ hasText: exactly('Drill to detail') }),
    })
    .first();
}

/**
 * Hovers the "Drill to detail by" entry of an open context menu.
 *
 * @param enabledTimeout - How long to wait for the entry to become enabled,
 * which a menu opened away from a mark never does
 * @returns The submenu popup, or null when the menu offers no drill-by entry
 * (the datum under the cursor carries no dimension)
 */
async function openDrillBySubmenu(
  page: Page,
  enabledTimeout: number = TIMEOUT.UI_TRANSITION,
): Promise<Locator | null> {
  const drillBy = contextMenu(page)
    .locator(SELECTORS.MENU_ITEM)
    .filter({ hasText: exactly('Drill to detail by') })
    .first();
  // The entry is present but disabled while the menu is still resolving the
  // datum under the pointer, and stays disabled when there is none. Ant Design
  // marks a submenu as disabled on the list item that wraps its title.
  const enabled = await expect
    .poll(
      async () =>
        drillBy
          .evaluate(element =>
            `${element.className} ${element.closest('li')?.className ?? ''}`.includes(
              'disabled',
            ),
          )
          .catch(() => true),
      { timeout: enabledTimeout },
    )
    .toBe(false)
    .then(() => true)
    .catch(() => false);
  if (!enabled) {
    return null;
  }
  // The chart menu offers a "Drill by" submenu as well, so the one wanted here
  // is identified by the entries only the drill-to-detail submenu has.
  const submenu = page
    .locator(SELECTORS.SUBMENU)
    .filter({
      has: page
        .locator('[role="menuitem"]')
        .filter({ hasText: /^Drill to detail by .+/ }),
    })
    .first();
  // A hover that arrives while the menu is still animating open opens nothing,
  // so the pointer leaves the entry and returns.
  for (let attempt = 0; attempt < SUBMENU_HOVER_ATTEMPTS; attempt += 1) {
    await drillBy.hover();
    const opened = await submenu
      .waitFor({
        state: 'visible',
        timeout: TIMEOUT.UI_TRANSITION / SUBMENU_HOVER_ATTEMPTS,
      })
      .then(() => true)
      .catch(() => false);
    if (opened) {
      return submenu;
    }
    await contextMenu(page).hover({ position: { x: 2, y: 2 } });
  }
  return null;
}

/**
 * Opens the drill-to-detail modal from the "Drill to detail by <value>" entry
 * of an open context menu, and waits for its samples query.
 */
async function drillToDetailBy(page: Page, label: string): Promise<void> {
  const submenu = await openDrillBySubmenu(page);
  if (!submenu) {
    throw new Error('The context menu offers no "Drill to detail by" entry');
  }
  const samples = page.waitForResponse(SAMPLES_URL);
  await submenu
    .locator('[role="menuitem"]')
    .filter({ hasText: exactly(label) })
    .first()
    .click({ timeout: TIMEOUT.UI_TRANSITION });
  await expect(page.locator(SELECTORS.METADATA_BAR)).toBeVisible();
  await samples;
}

/**
 * Opens the drill-to-detail modal from the unfiltered "Drill to detail" entry
 * of an open context menu, and waits for its samples query.
 */
async function drillToDetail(page: Page): Promise<void> {
  const samples = page.waitForResponse(SAMPLES_URL);
  await contextMenu(page)
    .locator(SELECTORS.MENU_ITEM)
    .filter({ hasText: exactly('Drill to detail') })
    .first()
    .click({ timeout: TIMEOUT.UI_TRANSITION });
  await expect(page.locator(SELECTORS.METADATA_BAR)).toBeVisible();
  await samples;
}

/**
 * A candidate right-click target in viewport coordinates, weighted by the area
 * of the shape it belongs to, and flagged by whether it is that shape's centre
 * or a point on its outline. Marks of the two kinds are ranked against their own
 * kind, so that a hollow symbol's outline is not dropped in favour of the
 * unpainted middle it surrounds.
 */
type Mark = Point & { weight: number; onEdge: boolean };

/**
 * Returns the centres of the shapes an echarts chart has drawn, read from the
 * chart's own render tree.
 *
 * The Cypress spec right-clicked hard-coded pixel offsets tuned to one fixture
 * dashboard's cell sizes, which do not survive a different layout. Asking the
 * chart where it drew instead is exact: a symbol's centre is the point echarts
 * hit-tests as that datum, whatever the chart's size.
 *
 * The instance is reached through the React node that owns the chart, because
 * the bundle exports neither the echarts registry nor the instance itself.
 */
async function echartsMarks(chart: Locator): Promise<Mark[]> {
  return chart.evaluate(element => {
    interface Rect {
      x: number;
      y: number;
      width: number;
      height: number;
    }
    interface Shape {
      type: string;
      silent: boolean;
      shape?: { points?: unknown };
      style?: { fill?: unknown };
      getBoundingRect(): Rect;
      transformCoordToGlobal(x: number, y: number): number[];
    }
    interface Instance {
      getZr(): { storage: { getDisplayList(update: boolean): Shape[] } };
      convertToPixel: unknown;
    }
    interface Hook {
      memoizedState: unknown;
      next: Hook | null;
    }
    interface Fiber {
      memoizedState: Hook | null;
      return: Fiber | null;
    }

    const isInstance = (value: unknown): value is Instance =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as Instance).getZr === 'function' &&
      typeof (value as Instance).convertToPixel === 'function';

    // The chart component holds its echarts instance in a ref, and a ref's
    // value is reachable from the DOM node's fiber.
    const instanceOf = (holder: Element): Instance | null => {
      const key = Object.keys(holder).find(name =>
        name.startsWith('__reactFiber$'),
      );
      let fiber = key
        ? (holder[key as keyof Element] as unknown as Fiber | null)
        : null;
      while (fiber) {
        let hook = fiber.memoizedState;
        while (hook) {
          const { memoizedState: value } = hook;
          const current =
            typeof value === 'object' && value !== null
              ? (value as { current?: unknown }).current
              : undefined;
          if (isInstance(current)) {
            return current;
          }
          hook = hook.next;
        }
        fiber = fiber.return;
      }
      return null;
    };

    const marks: {
      x: number;
      y: number;
      weight: number;
      onEdge: boolean;
    }[] = [];
    element.querySelectorAll('div[_echarts_instance_]').forEach(holder => {
      const instance = instanceOf(holder);
      if (!instance) {
        return;
      }
      const box = holder.getBoundingClientRect();
      instance
        .getZr()
        .storage.getDisplayList(true)
        .forEach(shape => {
          // Axes and gridlines are drawn as shapes that take no pointer events,
          // and text is drawn as a shape of its own.
          if (shape.silent || shape.type.startsWith('t')) {
            return;
          }
          const rect = shape.getBoundingRect();
          const weight = rect.width * rect.height;
          const at = (localX: number, localY: number, onEdge: boolean) => {
            const [x, y] = shape.transformCoordToGlobal(localX, localY);
            marks.push({
              x: Math.round(box.left + x),
              y: Math.round(box.top + y),
              weight,
              onEdge,
            });
          };

          // A line is hit-tested on the line, so its vertices — the points it
          // was drawn through — are where its data sits. They come either as
          // pairs or as one flat run of coordinates.
          const { points } = shape.shape ?? {};
          if (
            typeof points === 'object' &&
            points !== null &&
            'length' in points
          ) {
            const vertices = points as ArrayLike<unknown>;
            if (typeof vertices[0] === 'number') {
              for (let index = 0; index + 1 < vertices.length; index += 2) {
                at(
                  vertices[index] as number,
                  vertices[index + 1] as number,
                  true,
                );
              }
            } else {
              Array.from(vertices).forEach(vertex => {
                if (Array.isArray(vertex) && vertex.length >= 2) {
                  at(Number(vertex[0]), Number(vertex[1]), true);
                }
              });
            }
            return;
          }

          const fill = shape.style?.fill;
          const isFilled =
            typeof fill === 'string' &&
            fill !== 'none' &&
            fill !== 'transparent' &&
            !fill.endsWith(',0)');
          if (!isFilled) {
            return;
          }
          at(rect.x + rect.width / 2, rect.y + rect.height / 2, false);
          // A symbol drawn as a ring is hit-tested on the ring, not in the
          // unpainted middle the centre lands in.
          at(rect.x + rect.width / 2, rect.y, true);
        });
    });
    return marks;
  });
}

/**
 * Returns the centres of the SVG shapes filled in a series colour, weighted by
 * painted area. Charts that render to SVG expose their marks as elements.
 */
async function svgMarks(shapes: Locator): Promise<Mark[]> {
  return shapes.evaluateAll(
    (elements, { saturation }) => {
      const marks: {
        x: number;
        y: number;
        weight: number;
        onEdge: boolean;
      }[] = [];
      elements.forEach(element => {
        const { fill } = window.getComputedStyle(element);
        const channels = fill.match(/\d+/g);
        if (!channels || channels.length < 3) {
          return;
        }
        const [red, green, blue] = channels.map(Number);
        const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
        if (spread <= saturation) {
          return;
        }
        const box = element.getBoundingClientRect();
        if (box.width < 4 || box.height < 4) {
          return;
        }
        marks.push({
          x: Math.round(box.left + box.width / 2),
          y: Math.round(box.top + box.height / 2),
          weight: box.width * box.height,
          onEdge: false,
        });
      });
      return marks;
    },
    { saturation: COLOUR_SATURATION },
  );
}

/**
 * Returns the positions, relative to the chart, of the marks a right-click can
 * land on, largest first. Positions closer together than one mark's width are
 * collapsed, so each candidate stands for a different mark.
 */
async function chartMarks(chart: Locator): Promise<Point[]> {
  const marks = await echartsMarks(chart);
  if (marks.length === 0) {
    marks.push(
      ...(await svgMarks(
        chart.locator('svg path, svg rect, svg circle, svg polygon'),
      )),
    );
  }

  // One shape yields a candidate of each kind, so the largest shape of each
  // cluster stands for the mark there and the rest are dropped.
  const thinOut = (group: Mark[]): Point[] => {
    const kept: Point[] = [];
    group
      .sort((left, right) => right.weight - left.weight)
      .forEach(mark => {
        const isNewMark = kept.every(
          point =>
            Math.abs(point.x - mark.x) > MARK_SPACING ||
            Math.abs(point.y - mark.y) > MARK_SPACING,
        );
        if (isNewMark) {
          kept.push({ x: mark.x, y: mark.y });
        }
      });
    return kept;
  };
  const chosen = [
    ...thinOut(marks.filter(mark => !mark.onEdge)),
    ...thinOut(marks.filter(mark => mark.onEdge)),
  ];

  // Points covered by something else — a dashboard's sticky header overlaps the
  // charts scrolled under it — are dropped, and the rest are returned relative
  // to the chart, which survives the dashboard scrolling between measuring a
  // mark and clicking it.
  return chart.evaluate((element, points) => {
    const box = element.getBoundingClientRect();
    return points
      .filter(point => {
        const top = document.elementFromPoint(point.x, point.y);
        return top !== null && element.contains(top);
      })
      .map(point => ({
        x: Math.round(point.x - box.left),
        y: Math.round(point.y - box.top),
      }));
  }, chosen);
}

/**
 * Returns a grid of positions across a chart, relative to it.
 *
 * Probed behind a chart's marks: a cartesian chart answers a right-click
 * anywhere in a category's band with that category's datum, and a chart whose
 * marks are hairline-thin — a box plot of one observation per category — offers
 * nothing to right-click.
 */
async function chartGrid(chart: Locator): Promise<Point[]> {
  return chart.evaluate((element, grid) => {
    const box = element.getBoundingClientRect();
    const points: { x: number; y: number }[] = [];
    for (let column = 1; column < grid; column += 1) {
      for (let row = 1; row < grid; row += 1) {
        const x = Math.round((box.width * column) / grid);
        const y = Math.round((box.height * row) / grid);
        const top = document.elementFromPoint(box.left + x, box.top + y);
        if (top !== null && element.contains(top)) {
          points.push({ x, y });
        }
      }
    }
    return points;
  }, CHART_GRID);
}

/**
 * Picks the points to probe: the most mark-like ones first, then the ones
 * furthest from everything already picked.
 *
 * Weight alone concentrates the probes inside whichever shape is largest, and a
 * chart's marks each carry a different value — the value the test is about may
 * be the smallest slice of a pie or one rectangle of a treemap — so the search
 * is spread across the chart rather than run in weight order.
 */
function spreadOut(points: Point[], count: number): Point[] {
  const pool = [...points];
  const chosen: Point[] = pool.splice(0, WEIGHTED_PROBES);
  while (chosen.length < count && pool.length > 0) {
    let furthest = 0;
    let distance = -1;
    pool.forEach((point, index) => {
      const nearest = Math.min(
        ...chosen.map(
          other => (other.x - point.x) ** 2 + (other.y - point.y) ** 2,
        ),
      );
      if (nearest > distance) {
        distance = nearest;
        furthest = index;
      }
    });
    chosen.push(...pool.splice(furthest, 1));
  }
  return chosen;
}

/**
 * Right-clicks an element and waits for its chart context menu, retrying the
 * click. A chart ignores a right-click that arrives before it has registered its
 * own handler, and reports nothing when it does.
 */
async function rightClick(page: Page, target: Locator): Promise<void> {
  await closeContextMenu(page);
  await target.scrollIntoViewIfNeeded();
  for (let attempt = 0; attempt < RIGHT_CLICK_ATTEMPTS; attempt += 1) {
    await page.mouse.move(1, 1);
    await target.hover();
    await target.click({ button: 'right' });
    const opened = await contextMenu(page)
      .waitFor({ state: 'visible', timeout: TIMEOUT.UI_TRANSITION })
      .then(() => true)
      .catch(() => false);
    if (opened) {
      return;
    }
  }
  throw new Error('The chart opened no context menu on a right-click');
}

/**
 * Right-clicks an element and drills from the context menu it opens, retrying
 * the pair. The menu of a chart that re-renders under the pointer closes on its
 * own, and an entry of a closing menu cannot be clicked.
 */
async function drillFromElement(
  page: Page,
  target: Locator,
  label?: string,
): Promise<void> {
  for (let attempt = 1; attempt <= RIGHT_CLICK_ATTEMPTS; attempt += 1) {
    await rightClick(page, target);
    try {
      if (label === undefined) {
        await drillToDetail(page);
      } else {
        await drillToDetailBy(page, label);
      }
      return;
    } catch (error) {
      if (attempt === RIGHT_CLICK_ATTEMPTS) {
        throw error;
      }
    }
  }
}

/**
 * Right-clicks one point and returns the drills the resulting context menu
 * offers when they include every requested one, and null otherwise. Leaves the
 * menu and its drill-by submenu open on a match.
 */
async function contextMenuOffers(
  page: Page,
  chart: Locator,
  point: Point,
  labels: (string | RegExp)[],
): Promise<string[] | null> {
  await closeContextMenu(page);
  // The menu describes the datum under the pointer, and a chart tracks the
  // pointer by the moves it sees: the pointer is walked to the mark from a
  // corner of the chart, so the chart sees it arrive, and the right-click is
  // sent to the position it stopped at.
  const box = await chart.boundingBox();
  if (!box) {
    return null;
  }
  const x = box.x + point.x;
  const y = box.y + point.y;
  await page.mouse.move(1, 1);
  await page.mouse.move(box.x + 1, box.y + 1);
  await page.mouse.move(x, y, { steps: POINTER_STEPS });
  await page.waitForTimeout(MENU_SETTLE);
  await page.mouse.click(x, y, { button: 'right' });
  await page.waitForTimeout(MENU_SETTLE);

  const submenu = await openDrillBySubmenu(page, PROBE_TIMEOUT);
  if (submenu) {
    // A submenu is visible before its items are mounted, so the entries are
    // read until they arrive.
    const items = submenu.locator('[role="menuitem"]');
    const offered = await expect
      .poll(
        async () =>
          items
            .allInnerTexts()
            .then(texts => texts.map(text => text.trim()))
            .catch((): string[] => []),
        { timeout: PROBE_TIMEOUT },
      )
      .not.toHaveLength(0)
      .then(() => items.allInnerTexts())
      .catch((): string[] => []);
    const trimmed = offered.map(text => text.trim());
    const isOffered = (label: string | RegExp) =>
      typeof label === 'string'
        ? trimmed.includes(label)
        : trimmed.some(text => label.test(text));
    if (labels.every(isOffered)) {
      return trimmed;
    }
  }

  return null;
}

/**
 * Right-clicks the chart's marks until the context menu offers every requested
 * drill, leaving that menu open.
 *
 * @param labels - Drill-by labels the datum must offer, e.g.
 * `['Drill to detail by boy']`
 */
async function rightClickChartOffering(
  page: Page,
  chart: Locator,
  labels: (string | RegExp)[],
): Promise<string[]> {
  // A menu left open from an earlier drill covers the chart, and a covered mark
  // is not a candidate.
  await closeContextMenu(page);
  await chart.scrollIntoViewIfNeeded();
  // A chart element exists before its series are painted, and is repainted
  // whenever the drill-to-detail modal closes over it.
  // The count is read until it repeats, because a chart part-way through a
  // paint offers fewer marks than the finished one.
  let marks: Point[] = [];
  let previous = -1;
  await expect
    .poll(
      async () => {
        const current = await chartMarks(chart);
        const settled = current.length > 0 && current.length === previous;
        previous = current.length;
        marks = current;
        return settled;
      },
      { timeout: TIMEOUT.CHART_RENDER },
    )
    .toBe(true);

  const probes = [
    ...spreadOut(marks, MAX_PROBES),
    ...(await chartGrid(chart)),
  ].slice(0, MAX_PROBES);
  for (const point of probes) {
    const offered = await contextMenuOffers(page, chart, point, labels);
    if (offered) {
      return offered;
    }
  }

  throw new Error(
    `No mark on the chart offered ${labels.join(' and ')} ` +
      `(probed ${probes.length} candidates)`,
  );
}

const filterValues = (page: Page) => page.locator(SELECTORS.FILTER_VAL);

/**
 * Builds a single-chart dashboard and waits for the chart to render.
 *
 * @returns The dashboard's only chart element, addressed the way the Cypress
 * spec addressed charts — by viz type
 */
async function openDashboardWith(
  page: Page,
  testAssets: Parameters<typeof createDashboardWithCharts>[1],
  testInfo: Parameters<typeof createDashboardWithCharts>[2],
  spec: DashboardChartSpec,
): Promise<{ chart: Locator; sliceName: string }> {
  const { dashboardId, charts } = await createDashboardWithCharts(
    page,
    testAssets,
    testInfo,
    {
      datasetName: DATASET_NAME,
      chartNamePrefix: 'drill_to_detail',
      dashboardTitlePrefix: 'drill_to_detail',
      chartSpecs: [spec],
    },
  );

  const dashboardPage = new DashboardPage(page);
  await dashboardPage.gotoById(dashboardId);
  await dashboardPage.waitForChartsToLoad({ timeout: TIMEOUT.CHART_RENDER });

  return {
    chart: chartOf(page, spec.viz_type),
    sliceName: charts[0].sliceName,
  };
}

/**
 * Time-series params shared by the echarts line-family charts.
 *
 * The series is narrowed to two years, and markers are enlarged, so that the
 * canvas carries a handful of widely spaced marks for the search to land on
 * rather than 44 years of overlapping ones. The Cypress spec got the same
 * determinism from hard-coded pixel offsets into a fixture dashboard.
 */
const timeseriesParams = {
  x_axis: 'ds',
  time_grain_sqla: 'P1Y',
  metrics: ['count'],
  groupby: ['gender'],
  markerEnabled: true,
  markerSize: 20,
  adhoc_filters: [
    {
      clause: 'WHERE',
      subject: 'ds',
      operator: 'TEMPORAL_RANGE',
      comparator: '1965-01-01 : 1967-01-01',
      expressionType: 'SIMPLE',
    },
  ],
};

/** Params for the box plot drilled by gender. */
const boxPlotParams = {
  groupby: ['gender'],
  metrics: ['count'],
  x_axis: 'ds',
  time_grain_sqla: 'P1Y',
  whiskerOptions: 'Tukey',
};

/** Params for the categorical charts drilled by gender. */
const genderParams = {
  groupby: ['gender'],
  metric: 'count',
};

/**
 * The Cypress spec exercised each viz type identically: right-click a datum,
 * drill by the year, by the series, and by both at once. That shape is kept.
 */
async function testTimeChart(page: Page, vizType: string): Promise<void> {
  const chart = chartOf(page, vizType);
  const labels = [
    'Drill to detail by 1965',
    'Drill to detail by boy',
    'Drill to detail by all',
  ];

  // The search runs again before each drill: closing the modal re-renders the
  // chart, which moves its marks.
  await rightClickChartOffering(page, chart, labels);
  await drillToDetailBy(page, 'Drill to detail by 1965');
  await expect(filterValues(page)).toContainText(['1965']);
  await closeModal(page);

  await rightClickChartOffering(page, chart, labels);
  await drillToDetailBy(page, 'Drill to detail by boy');
  await expect(filterValues(page)).toContainText(['boy']);
  await closeModal(page);

  await rightClickChartOffering(page, chart, labels);
  await drillToDetailBy(page, 'Drill to detail by all');
  await expect(filterValues(page).first()).toContainText('1965');
  await expect(filterValues(page).nth(1)).toContainText('boy');
  await closeModal(page);
}

/** Right-clicks two data points of a categorical chart and drills by each. */
async function testGenderChart(page: Page, vizType: string): Promise<void> {
  const chart = chartOf(page, vizType);

  for (const gender of ['boy', 'girl']) {
    const label = `Drill to detail by ${gender}`;
    await rightClickChartOffering(page, chart, [label]);
    await drillToDetailBy(page, label);
    await expect(filterValues(page)).toContainText([gender]);
    await closeModal(page);
  }
}

const BIG_NUMBER_TOTAL: DashboardChartSpec = {
  viz_type: 'big_number_total',
  params: { metric: 'count' },
};

const BIG_NUMBER: DashboardChartSpec = {
  viz_type: 'big_number',
  params: {
    metric: 'count',
    x_axis: 'ds',
    time_grain_sqla: 'P1Y',
  },
};

testWithAssets(
  'Drill to detail modal opens from the chart menu',
  async ({ page, testAssets }, testInfo) => {
    const { chart, sliceName } = await openDashboardWith(
      page,
      testAssets,
      testInfo,
      BIG_NUMBER_TOTAL,
    );

    const samples = page.waitForResponse(SAMPLES_URL);
    await chart.getByLabel('More Options').click();
    const menuItem = page
      .locator(SELECTORS.OPEN_DROPDOWN)
      .locator(SELECTORS.MENU_ITEM)
      .nth(DRILL_MENU_INDEX);
    await expect(menuItem).toContainText('Drill to detail');
    await menuItem.click();
    await samples;

    await expect(
      page.locator(SELECTORS.MODAL).locator(SELECTORS.MODAL_TITLE),
    ).toContainText(`Drill to detail: ${sliceName}`);
  },
);

testWithAssets(
  'Drill to detail modal refreshes the data',
  async ({ page, testAssets }, testInfo) => {
    const { chart } = await openDashboardWith(
      page,
      testAssets,
      testInfo,
      BIG_NUMBER_TOTAL,
    );

    const samples = page.waitForResponse(SAMPLES_URL);
    await chart.getByLabel('More Options').click();
    await page
      .locator(SELECTORS.OPEN_DROPDOWN)
      .locator(SELECTORS.MENU_ITEM)
      .nth(DRILL_MENU_INDEX)
      .click();
    await samples;

    // Move to the last page, then reload and land back on the first.
    const lastPage = page.waitForResponse(SAMPLES_URL);
    await page.locator(SELECTORS.PAGINATION_ITEM).nth(5).click();
    await lastPage;

    const reloaded = page.waitForResponse(SAMPLES_URL);
    await page.getByLabel('Reload').click();
    await reloaded;

    await expect(page.locator(SELECTORS.PAGINATION_ACTIVE)).toContainText('1');
  },
);

testWithAssets(
  'Drill to detail modal paginates',
  async ({ page, testAssets }, testInfo) => {
    const { chart } = await openDashboardWith(
      page,
      testAssets,
      testInfo,
      BIG_NUMBER_TOTAL,
    );

    const samples = page.waitForResponse(SAMPLES_URL);
    await chart.getByLabel('More Options').click();
    await page
      .locator(SELECTORS.OPEN_DROPDOWN)
      .locator(SELECTORS.MENU_ITEM)
      .nth(DRILL_MENU_INDEX)
      .click();
    await samples;

    await expect(page.locator(SELECTORS.ROW_COUNT)).toContainText(ALL_ROWS);
    await expect(page.locator(SELECTORS.VIRTUAL_CELL).first()).toBeVisible();

    const pages = page.locator(SELECTORS.PAGINATION_ITEM);
    await expect(pages).toHaveCount(6);
    await expect(pages.first()).toContainText('1');
    await expect(pages.last()).toContainText(ALL_LAST_PAGE);

    // The Cypress spec named the values it expected on each page ('Amy' on the
    // first, 'Kimberly' on the fifth). Sample rows come back unordered, so the
    // page a given name lands on is not a property of the product; what is
    // asserted here instead is that a different page shows different rows.
    const grid = page.locator(SELECTORS.VIRTUAL_GRID).first();
    const firstPageRows = await grid.innerText();

    const paged = page.waitForResponse(SAMPLES_URL);
    await pages.nth(4).click();
    await paged;
    await expect(grid).not.toHaveText(firstPageRows);
    const fifthPageRows = await grid.innerText();

    // Scrolling the virtual grid renders rows from further down the page. The
    // Cypress spec asserted this as a named row going out of view; the rows a
    // page holds are not ordered, so what is asserted here is that scrolling
    // changed which rows are rendered.
    await grid.evaluate(element => element.scrollTo(0, 200));
    await expect
      .poll(() => grid.evaluate(element => element.scrollTop))
      .toBe(200);
    await expect(grid).not.toHaveText(fifthPageRows);

    // Paginating resets the scroll position, and shows the first page's rows
    // from the top rather than 200px up.
    await pages.first().click();
    await expect(page.locator(SELECTORS.PAGINATION_ACTIVE)).toContainText('1');
    await expect(grid).not.toHaveText(fifthPageRows);
    await expect
      .poll(() => grid.evaluate(element => element.scrollTop))
      .toBe(0);
  },
);

testWithAssets(
  'Drill to detail from a big number total opens with no filters',
  async ({ page, testAssets }, testInfo) => {
    const { chart } = await openDashboardWith(
      page,
      testAssets,
      testInfo,
      BIG_NUMBER_TOTAL,
    );

    await drillFromElement(page, chart.locator('.header-line'));

    await expect(filterValues(page)).toHaveCount(0);
  },
);

testWithAssets(
  'Drill to detail from a big number with trendline opens with the correct data',
  async ({ page, testAssets }, testInfo) => {
    const { chart } = await openDashboardWith(
      page,
      testAssets,
      testInfo,
      BIG_NUMBER,
    );

    await drillFromElement(page, chart.locator('.header-line'));
    await expect(filterValues(page)).toHaveCount(0);
    await closeModal(page);

    // The trendline carries the time dimension the header line does not. The
    // Cypress spec drilled the first year of the dataset by right-clicking a
    // fixed offset; the first year is drawn on the chart's edge, which echarts
    // does not hit-test, so whichever year the chart offers is drilled instead.
    const yearEntry = /^Drill to detail by \d{4}$/;
    const offered = await rightClickChartOffering(page, chart, [yearEntry]);
    const entry = offered.find(label => yearEntry.test(label)) as string;
    await drillToDetailBy(page, entry);
    await expect(filterValues(page)).toContainText([
      entry.replace('Drill to detail by ', ''),
    ]);
  },
);

testWithAssets(
  'Drill to detail from a table opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    const { chart } = await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'table',
      params: {
        query_mode: 'aggregate',
        groupby: ['gender'],
        metrics: ['count'],
      },
    });

    for (const gender of ['boy', 'girl']) {
      await drillFromElement(
        page,
        chart.getByText(gender, { exact: true }).first(),
        `Drill to detail by ${gender}`,
      );
      await expect(filterValues(page)).toContainText([gender]);
      await closeModal(page);
    }
  },
);

testWithAssets(
  'Drill to detail from a pivot table opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    const { chart } = await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'pivot_table_v2',
      params: {
        groupbyRows: ['gender'],
        groupbyColumns: ['state'],
        metrics: ['count'],
        aggregateFunction: 'Sum',
      },
    });

    // The Cypress spec addressed cells by their index in the grid, which counts
    // one column per state the dataset holds; the cells are addressed here by
    // the row and column they intersect instead.
    const cellAt = (row: string, column: number): Locator =>
      chart
        .locator('tr')
        .filter({ hasText: row })
        .locator('[role="gridcell"]')
        .nth(column);
    const boyInCalifornia = cellAt('boy', 0);
    const girlInFlorida = cellAt('girl', 1);

    // A pivot cell sits at the intersection of a row and a column dimension, so
    // it offers a drill for each of them and one for both together.
    for (const [cell, value] of [
      [boyInCalifornia, 'boy'],
      [boyInCalifornia, 'CA'],
      [girlInFlorida, 'girl'],
      [girlInFlorida, 'FL'],
    ] as const) {
      await drillFromElement(page, cell, `Drill to detail by ${value}`);
      await expect(filterValues(page)).toContainText([value]);
      await closeModal(page);
    }

    await drillFromElement(page, girlInFlorida, 'Drill to detail by all');
    await expect(filterValues(page).first()).toContainText('girl');
    await expect(filterValues(page).nth(1)).toContainText('FL');
  },
);

testWithAssets(
  'Drill to detail from a line chart opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'echarts_timeseries_line',
      params: timeseriesParams,
    });
    await testTimeChart(page, 'echarts_timeseries_line');
  },
);

// Skipped in the Cypress suite, where the right-click landed on the locked chart
// title as often as on a bar. The port right-clicks the bars the chart reports
// rather than a fixed offset, so the case runs here.
testWithAssets(
  'Drill to detail from a bar chart opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'echarts_timeseries_bar',
      params: timeseriesParams,
    });
    await testTimeChart(page, 'echarts_timeseries_bar');
  },
);

// Skipped in the Cypress suite alongside the bar chart, and runs here for the
// same reason.
testWithAssets(
  'Drill to detail from an area chart opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'echarts_area',
      params: timeseriesParams,
    });
    await testTimeChart(page, 'echarts_area');
  },
);

testWithAssets(
  'Drill to detail from a scatter chart opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'echarts_timeseries_scatter',
      params: timeseriesParams,
    });
    await testTimeChart(page, 'echarts_timeseries_scatter');
  },
);

testWithAssets(
  'Drill to detail from a pie chart opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'pie',
      params: genderParams,
    });
    await testGenderChart(page, 'pie');
  },
);

// Skipped in the Cypress suite: the world map's SVG right-click targets are
// country paths whose position depends on the projection. Kept skipped.
testWithAssets.fixme(
  'Drill to detail from a world map opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    const { chart } = await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'world_map',
      params: { entity: 'state', metric: 'count' },
    });

    for (const country of ['USA', 'SRB']) {
      await rightClickChartOffering(page, chart, [
        `Drill to detail by ${country}`,
      ]);
      await drillToDetailBy(page, `Drill to detail by ${country}`);
      await expect(filterValues(page)).toContainText([country]);
      await closeModal(page);
    }
  },
);

testWithAssets(
  'Drill to detail modal clears filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'box_plot',
      params: boxPlotParams,
    });

    const chart = chartOf(page, 'box_plot');
    await rightClickChartOffering(page, chart, ['Drill to detail by boy']);
    await drillToDetailBy(page, 'Drill to detail by boy');

    await expect(filterValues(page)).toContainText(['boy']);
    await expect(page.locator(SELECTORS.ROW_COUNT)).toContainText(BOY_ROWS);
    let pages = page.locator(SELECTORS.PAGINATION_ITEM);
    await expect(pages).toHaveCount(6);
    await expect(pages.first()).toContainText('1');
    await expect(pages.last()).toContainText(BOY_LAST_PAGE);

    // Removing the filter tag requeries for the whole dataset.
    const cleared = page.waitForResponse(SAMPLES_URL);
    await page.locator(SELECTORS.FILTER_COL).getByLabel('Close').click();
    await cleared;

    await expect(page.locator(SELECTORS.ROW_COUNT)).toContainText(ALL_ROWS);
    await expect(page.locator(SELECTORS.PAGINATION_ACTIVE)).toContainText('1');
    pages = page.locator(SELECTORS.PAGINATION_ITEM);
    await expect(pages).toHaveCount(6);
    await expect(pages.first()).toContainText('1');
    await expect(pages.last()).toContainText(ALL_LAST_PAGE);
  },
);

testWithAssets(
  'Drill to detail from a box plot opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'box_plot',
      params: boxPlotParams,
    });
    await testGenderChart(page, 'box_plot');
  },
);

testWithAssets(
  'Drill to detail from a generic chart opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'echarts_timeseries',
      params: timeseriesParams,
    });
    await testTimeChart(page, 'echarts_timeseries');
  },
);

testWithAssets(
  'Drill to detail from a smooth line chart opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'echarts_timeseries_smooth',
      params: timeseriesParams,
    });
    await testTimeChart(page, 'echarts_timeseries_smooth');
  },
);

testWithAssets(
  'Drill to detail from a step line chart opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'echarts_timeseries_step',
      params: timeseriesParams,
    });
    await testTimeChart(page, 'echarts_timeseries_step');
  },
);

testWithAssets(
  'Drill to detail from a funnel chart opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'funnel',
      params: genderParams,
    });
    await testGenderChart(page, 'funnel');
  },
);

testWithAssets(
  'Drill to detail from a gauge chart opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'gauge_chart',
      params: genderParams,
    });
    await testGenderChart(page, 'gauge_chart');
  },
);

// A right-click on a mark of a mixed chart opens a context menu whose "Drill to
// detail by" entry stays disabled, on every mark of either series: the datum the
// chart reports carries no dimension for the menu to filter by. The Cypress
// spec asserted this case, and its whole drill-to-detail suite is skipped, so
// the behaviour it expected has not been exercised either.
testWithAssets.fixme(
  'Drill to detail from a mixed chart opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'mixed_timeseries',
      params: {
        ...timeseriesParams,
        metrics_b: ['count'],
        groupby_b: ['gender'],
        adhoc_filters_b: timeseriesParams.adhoc_filters,
        markerEnabledB: true,
        markerSizeB: 20,
      },
    });
    await testTimeChart(page, 'mixed_timeseries');
  },
);

// Skipped in the Cypress suite: the radar chart's clickable area is a thin
// polygon edge. Kept skipped.
testWithAssets.fixme(
  'Drill to detail from a radar chart opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'radar',
      params: { groupby: ['gender'], metrics: ['count'] },
    });
    await testGenderChart(page, 'radar');
  },
);

testWithAssets(
  'Drill to detail from a treemap opens with the correct filters',
  async ({ page, testAssets }, testInfo) => {
    await openDashboardWith(page, testAssets, testInfo, {
      viz_type: 'treemap_v2',
      params: genderParams,
    });
    await testGenderChart(page, 'treemap_v2');
  },
);
