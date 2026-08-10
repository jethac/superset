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
import type { Locator, Page } from '@playwright/test';
import { expect, type TestAssets } from '../../helpers/fixtures';
import { apiPostChart, apiPutChart } from '../../helpers/api/chart';
import {
  apiPostDashboard,
  buildSingleRowDashboardLayout,
} from '../../helpers/api/dashboard';
import { getDatasetByName } from '../../helpers/api/dataset';
import { extractIdFromResponse } from '../../helpers/api/assertions';
import { DashboardPage } from '../../pages/DashboardPage';
import { TIMEOUT } from '../../utils/constants';

/** Dataset every drill-to-detail chart in this suite is built on. */
export const DATASET_NAME = 'birth_names';

/** Dimension whose values (`boy`/`girl`) the drill assertions key off. */
export const GENDER_COLUMN = 'gender';

/** Values of {@link GENDER_COLUMN} in the `birth_names` example data. */
export const GENDERS = ['boy', 'girl'] as const;

/**
 * Params shared by every chart built here: a `count` metric grouped by gender,
 * so each chart offers a two-value dimension to drill by.
 */
const SHARED_PARAMS = {
  metrics: ['count'],
  adhoc_filters: [],
  row_limit: 100,
  color_scheme: 'supersetColors',
};

/** Params shared by the ECharts time-series family (x axis + time grain). */
const TIMESERIES_PARAMS = {
  ...SHARED_PARAMS,
  x_axis: 'ds',
  time_grain_sqla: 'P1Y',
  groupby: [GENDER_COLUMN],
  // Markers widen the hit area of a series' data points, which is what a
  // right-click has to land on.
  markerEnabled: true,
  markerSize: 10,
};

/**
 * Viz-type-specific `params` for each chart the drill-to-detail suite needs,
 * mirroring the chart set of the Cypress `supported_charts_dash` fixture.
 */
const CHART_PARAMS: Record<string, Record<string, unknown>> = {
  big_number_total: { ...SHARED_PARAMS, metric: 'count' },
  big_number: {
    ...SHARED_PARAMS,
    metric: 'count',
    x_axis: 'ds',
    time_grain_sqla: 'P1Y',
  },
  table: {
    ...SHARED_PARAMS,
    query_mode: 'aggregate',
    groupby: [GENDER_COLUMN],
  },
  pivot_table_v2: {
    ...SHARED_PARAMS,
    groupbyRows: [GENDER_COLUMN],
    groupbyColumns: ['state'],
    aggregateFunction: 'Sum',
  },
  echarts_timeseries_line: TIMESERIES_PARAMS,
  echarts_timeseries_bar: TIMESERIES_PARAMS,
  echarts_timeseries_scatter: TIMESERIES_PARAMS,
  echarts_timeseries_smooth: TIMESERIES_PARAMS,
  echarts_timeseries_step: TIMESERIES_PARAMS,
  echarts_timeseries: TIMESERIES_PARAMS,
  echarts_area: TIMESERIES_PARAMS,
  // Box plot puts `groupby` on the x axis and distributes each box across
  // `columns`, so gender boxes need the time column as the distribution.
  box_plot: {
    ...SHARED_PARAMS,
    groupby: [GENDER_COLUMN],
    columns: ['ds'],
    whiskerOptions: 'Tukey',
  },
  pie: { ...SHARED_PARAMS, metric: 'count', groupby: [GENDER_COLUMN] },
  funnel: { ...SHARED_PARAMS, metric: 'count', groupby: [GENDER_COLUMN] },
  gauge_chart: { ...SHARED_PARAMS, metric: 'count', groupby: [GENDER_COLUMN] },
  treemap_v2: { ...SHARED_PARAMS, metric: 'count', groupby: [GENDER_COLUMN] },
  // A radar needs at least two metrics: one draws a degenerate single-axis
  // polygon with nothing to right-click.
  radar: {
    ...SHARED_PARAMS,
    metrics: ['count', 'sum__num'],
    groupby: [GENDER_COLUMN],
  },
  mixed_timeseries: {
    ...TIMESERIES_PARAMS,
    // Two metrics keep the backend's series labels prefixed with the metric,
    // which is what the chart's drill lookup keys its label map by.
    metrics: ['count', 'sum__num'],
    // Query B is given its own metric and axis: a copy of query A would draw
    // over it, leaving A's marks unclickable.
    metrics_b: ['sum__num'],
    groupby_b: [GENDER_COLUMN],
    adhoc_filters_b: [],
    row_limit_b: 100,
    yAxisIndexB: 1,
  },
};

interface DrillDashboard {
  dashboardId: number;
  /** Chart ids in the order the viz types were requested. */
  chartIds: number[];
  chartNames: string[];
}

/**
 * Creates a chart per viz type on `birth_names` plus a dashboard holding them,
 * tracked for cleanup. Charts are created per test rather than shared, so each
 * test owns its data and the suite stays parallelizable.
 */
export async function createDrillDashboard(
  page: Page,
  testAssets: TestAssets,
  vizTypes: string[],
): Promise<DrillDashboard> {
  const dataset = await getDatasetByName(page, DATASET_NAME);
  if (!dataset) {
    throw new Error(`Dataset ${DATASET_NAME} not found`);
  }

  const chartIds: number[] = [];
  const chartNames: string[] = [];
  for (const vizType of vizTypes) {
    const params = CHART_PARAMS[vizType];
    if (!params) {
      throw new Error(`No drill-to-detail chart params for ${vizType}`);
    }
    const sliceName = `drill_${vizType}_${Date.now()}`;
    const response = await apiPostChart(page, {
      slice_name: sliceName,
      viz_type: vizType,
      datasource_id: dataset.id,
      datasource_type: 'table',
      params: JSON.stringify({
        ...params,
        datasource: `${dataset.id}__table`,
        viz_type: vizType,
      }),
    });
    expect(response.ok()).toBe(true);
    const chartId = await extractIdFromResponse(response);
    testAssets.trackChart(chartId);
    chartIds.push(chartId);
    chartNames.push(sliceName);
  }

  const positionJson = buildSingleRowDashboardLayout(
    chartIds.map((id, index) => ({
      id,
      sliceName: chartNames[index],
      width: Math.max(4, Math.floor(12 / chartIds.length)),
      // Short enough for a chart to fit the viewport whole: a mark scrolled out
      // of view cannot be right-clicked.
      height: 40,
    })),
  );
  const dashboardResponse = await apiPostDashboard(page, {
    dashboard_title: `drill_to_detail_${Date.now()}`,
    published: true,
    position_json: JSON.stringify(positionJson),
  });
  expect(dashboardResponse.ok()).toBe(true);
  const dashboardId = await extractIdFromResponse(dashboardResponse);
  testAssets.trackDashboard(dashboardId);

  for (const chartId of chartIds) {
    await apiPutChart(page, chartId, { dashboards: [dashboardId] });
  }

  return { dashboardId, chartIds, chartNames };
}

/**
 * Creates the charts and dashboard of {@link createDrillDashboard}, opens the
 * dashboard and waits for its charts to render.
 *
 * @returns The dashboard page object and the created charts, per viz type
 */
export async function openDrillDashboard(
  page: Page,
  testAssets: TestAssets,
  vizTypes: string[],
): Promise<{ dashboardPage: DashboardPage; charts: Locator[] }> {
  const { dashboardId, chartIds } = await createDrillDashboard(
    page,
    testAssets,
    vizTypes,
  );
  const dashboardPage = new DashboardPage(page);
  await dashboardPage.gotoById(dashboardId);
  await dashboardPage.waitForLoad();
  await dashboardPage.waitForChartsToLoad({ timeout: TIMEOUT.CHART_RENDER });
  return {
    dashboardPage,
    charts: chartIds.map(chartId => dashboardPage.getChart(chartId)),
  };
}

/** The chart context menu — the dropdown a right-click on a chart opens. */
export function contextMenu(page: Page): Locator {
  return page.locator('[data-test="chart-context-menu"]:visible').first();
}

/** Menu item that opens the modal unfiltered. */
export function drillToDetailItem(page: Page): Locator {
  return contextMenu(page).getByRole('menuitem', {
    name: 'Drill to detail',
    exact: true,
  });
}

/** Submenu parent listing one drill option per dimension of the clicked point. */
export function drillToDetailByItem(page: Page): Locator {
  return contextMenu(page).locator('.ant-dropdown-menu-submenu-title', {
    hasText: 'Drill to detail by',
  });
}

/**
 * Opens the "Drill to detail by" submenu of an already-open context menu and
 * returns its items.
 */
export async function openDrillBySubmenu(
  page: Page,
  timeout: number = TIMEOUT.PAGE_LOAD,
): Promise<Locator> {
  // The dropdown animates as it opens and can extend past the viewport, so
  // neither hover's stability nor its visibility checks are met; the submenu
  // opens on the event alone, and dispatching it leaves the pointer where it
  // is, which is what keeps the submenu open.
  await drillToDetailByItem(page).dispatchEvent('mouseover', { timeout });
  const submenu = page.locator('.chart-context-submenu:visible').first();
  await submenu.waitFor({ state: 'visible', timeout });
  const items = submenu.getByRole('menuitem');
  await items.first().waitFor({ state: 'visible', timeout });
  return items;
}

/** Closes any open context menu. */
export async function closeContextMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await contextMenu(page)
    .waitFor({ state: 'hidden', timeout: TIMEOUT.PAGE_LOAD })
    .catch(() => undefined);
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Finds viewport points that sit on a canvas chart's data marks.
 *
 * ECharts renders to a canvas and only fires `contextmenu` when the pointer is
 * over a rendered mark, so a drill-to-detail test needs the coordinates of the
 * marks — which no DOM node exposes. The Cypress suite solved this with pixel
 * offsets hard-coded per chart, which bind a test to one dashboard layout and
 * viewport. Reading the canvas instead finds the marks wherever they land: a
 * mark is drawn in one of the palette's saturated series colours, while the
 * grid, labels and background are greys, so clustering the canvas' saturated
 * pixels by colour yields one cluster per series.
 *
 * Points from the top of the canvas are dropped: the legend draws its swatches
 * in the same series colours and carries no drill affordance.
 *
 * @returns Candidate points, ordered by how much of the chart their colour
 * covers, with at most `pointsPerColor` points per series
 */
export async function findChartMarkPoints(
  chart: Locator,
  pointsPerColor = 3,
): Promise<Point[]> {
  return chart.evaluate((element, perColor) => {
    const canvas = element.querySelector('canvas');
    if (!canvas) {
      throw new Error('Chart has no canvas');
    }
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas has no 2d context');
    }
    const rect = canvas.getBoundingClientRect();
    const { width, height } = canvas;
    const { data } = context.getImageData(0, 0, width, height);
    const step = Math.max(1, Math.floor(width / 400));
    // Legend swatches use the series colours but offer no drill options.
    const legendCutoff = height * 0.12;
    const clusters = new Map<string, { x: number; y: number }[]>();
    for (let y = Math.ceil(legendCutoff); y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const offset = (y * width + x) * 4;
        const [red, green, blue, alpha] = [
          data[offset],
          data[offset + 1],
          data[offset + 2],
          data[offset + 3],
        ];
        // Marks are drawn with partial opacity, so only near-transparent
        // pixels are background.
        if (alpha < 60) {
          continue;
        }
        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);
        if (max - min < 30) {
          continue;
        }
        const key = [red, green, blue].map(c => c >> 4).join(',');
        const points = clusters.get(key) ?? [];
        points.push({ x, y });
        clusters.set(key, points);
      }
    }
    const scaleX = rect.width / width;
    const scaleY = rect.height / height;
    const inViewport = (point: { x: number; y: number }) =>
      point.x >= 0 &&
      point.y >= 0 &&
      point.x <= window.innerWidth &&
      point.y <= window.innerHeight;
    return (
      [...clusters.values()]
        .filter(points => points.length > 2)
        .sort((a, b) => b.length - a.length)
        // Antialiasing spreads a mark's colour over neighbouring buckets, so
        // only the largest clusters are distinct series.
        .slice(0, 4)
        .flatMap(points =>
          // Spread the picks across the cluster: consecutive pixels belong to the
          // same mark, so neighbours add no coverage.
          Array.from({ length: perColor }, (_unused, index) => {
            const pick =
              points[Math.floor((points.length * (index + 0.5)) / perColor)];
            return {
              x: rect.left + (pick.x + 0.5) * scaleX,
              y: rect.top + (pick.y + 0.5) * scaleY,
            };
          }).filter(inViewport),
        )
    );
  }, pointsPerColor);
}

/**
 * Candidate mark points, waiting for the chart to have painted any.
 *
 * A canvas exists before ECharts paints into it, and repaints can leave it
 * momentarily blank.
 */
async function markPoints(
  chart: Locator,
  pointsPerColor: number,
): Promise<Point[]> {
  let points: Point[] = [];
  await expect
    .poll(
      async () => {
        points = await findChartMarkPoints(chart, pointsPerColor);
        return points.length;
      },
      { timeout: TIMEOUT.CHART_RENDER },
    )
    .toBeGreaterThan(0);
  return points;
}

/**
 * The canvas an ECharts-based chart renders into, once it has been drawn.
 *
 * The canvas is created after the chart's data arrives, so waiting on it is
 * what makes a right-click land on a rendered mark rather than empty space.
 */
export async function chartCanvas(chart: Locator): Promise<Locator> {
  const canvas = chart.locator('canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: TIMEOUT.CHART_RENDER });
  await canvas.scrollIntoViewIfNeeded();
  // A canvas exists before ECharts paints into it, and an unpainted canvas has
  // no marks to right-click.
  await expect
    .poll(async () => (await findChartMarkPoints(chart, 1)).length, {
      timeout: TIMEOUT.CHART_RENDER,
    })
    .toBeGreaterThan(0);
  return canvas;
}

/** A chart mark, with the drill-by options it offers. */
export interface DrillMark {
  point: Point;
  /** Dimension values the mark can be drilled by, in the submenu's order. */
  values: string[];
}

/**
 * Right-clicks a viewport point, waiting for the chart context menu to open.
 */
export async function rightClickAt(page: Page, point: Point): Promise<void> {
  // ECharts resolves the pointed mark from its own pointer tracking, which a
  // click alone does not update.
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await contextMenu(page).waitFor({ state: 'visible' });
}

/**
 * Dimension values offered by the "Drill to detail by" submenu of an open
 * context menu, in the order shown.
 */
export async function drillByValues(
  page: Page,
  timeout?: number,
): Promise<string[]> {
  const items = await openDrillBySubmenu(page, timeout);
  const labels = await items.allInnerTexts();
  return labels
    .map(label => label.trim().replace(/^Drill to detail by /, ''))
    .filter(Boolean);
}

/**
 * Searches a canvas chart for marks whose drill-by options satisfy the given
 * predicates, right-clicking candidate marks until each predicate has a match.
 *
 * A mark's own submenu is the only source of the values it can be drilled by,
 * so the search reports them rather than assuming what a coordinate holds.
 *
 * @param accepts - One predicate per mark wanted, each taking the dimension
 * values a mark offers
 * @returns One mark per predicate, in the order the predicates were given
 * @throws If any predicate goes unmatched
 */
export async function findDrillMarks(
  page: Page,
  chart: Locator,
  accepts: readonly ((values: string[]) => boolean)[],
): Promise<DrillMark[]> {
  const matches = new Map<number, DrillMark>();
  const probed = new Set<string>();
  const seen: string[] = [];

  // Denser passes cost right-clicks, so start coarse: thin marks such as a
  // line's stroke cover few pixels and need more picks per series than a
  // filled slice does.
  for (const pointsPerColor of [4, 12]) {
    for (const point of await markPoints(chart, pointsPerColor)) {
      const key = `${Math.round(point.x)},${Math.round(point.y)}`;
      if (probed.has(key)) {
        continue;
      }
      probed.add(key);
      await page.mouse.move(point.x, point.y);
      await page.mouse.click(point.x, point.y, { button: 'right' });
      const opened = await contextMenu(page)
        .waitFor({ state: 'visible', timeout: 700 })
        .then(() => true)
        .catch(() => false);
      if (!opened) {
        continue;
      }
      if (await drillToDetailByItem(page).isVisible()) {
        // A menu can close under the probe, which leaves its options unknown
        // rather than failing the search: other candidates remain.
        const values = await drillByValues(page, 2000).catch(() => []);
        if (values.length > 0) {
          seen.push(values.join('/'));
          accepts.forEach((accept, index) => {
            if (!matches.has(index) && accept(values)) {
              matches.set(index, { point, values });
            }
          });
        }
      }
      await closeContextMenu(page);
      if (matches.size === accepts.length) {
        return accepts.map((_accept, index) => {
          const match = matches.get(index);
          if (!match) {
            throw new Error(`No mark matched predicate ${index}`);
          }
          return match;
        });
      }
    }
  }
  throw new Error(
    `Only ${matches.size} of ${accepts.length} drill marks found; ` +
      `marks offered: ${seen.join(' | ') || 'none'}`,
  );
}

/**
 * Chooses a "Drill to detail by" submenu option of an open context menu.
 *
 * @param value - The dimension value to drill by, without the label prefix
 */
export async function drillBy(page: Page, value: string): Promise<void> {
  const items = await openDrillBySubmenu(page);
  // The submenu stays open only while its parent is hovered, and moving the
  // pointer onto an item closes it, so the click is dispatched in place.
  await items
    .filter({ hasText: new RegExp(`^Drill to detail by ${value}$`) })
    .first()
    .dispatchEvent('click');
}

/** Chooses the unfiltered "Drill to detail" option of an open context menu. */
export async function drillToDetail(page: Page): Promise<void> {
  await drillToDetailItem(page).click();
}
