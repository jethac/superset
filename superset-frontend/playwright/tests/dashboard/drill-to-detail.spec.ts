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
 * Drill to detail, from a dashboard's charts.
 *
 * Ported from the Cypress suite `cypress/e2e/dashboard/drilltodetail.test.ts`,
 * which drove a fixture dashboard and addressed canvas charts by hard-coded
 * pixel offsets. Each test here builds the chart it needs on the `birth_names`
 * example data and locates canvas marks by reading the rendered canvas, so no
 * assertion depends on a chart's position in a layout.
 */
import { testWithAssets, expect } from '../../helpers/fixtures';
import { DrillToDetailModal } from '../../components/modals';
import { TIMEOUT } from '../../utils/constants';
import {
  chartCanvas,
  drillBy,
  drillToDetail,
  drillByValuesAt,
  drillChartMark,
  drillMarkBy,
  drillMarkMatching,
  findDrillMarks,
  GENDERS,
  openDrillDashboard,
} from './drill-to-detail-helpers';

/** A time value as the drill submenu formats a yearly time grain. */
const YEAR = /^\d{4}$/;

/**
 * Probing a canvas chart for its marks costs a right-click per candidate, which
 * outlasts the default per-test budget.
 */
const CANVAS_TEST_TIMEOUT = TIMEOUT.SLOW_TEST * 2;

/** Rows in the `birth_names` example data, as the modal labels them. */
const ALL_ROWS = '75.7k rows';

/** Rows left once the samples are filtered to a single gender. */
const BOY_ROWS = '39.2k rows';

/** Last page of the unfiltered samples, at the modal's default page size. */
const ALL_ROWS_LAST_PAGE = '1514';

/** Last page of the samples filtered to a single gender. */
const BOY_ROWS_LAST_PAGE = '785';

/** Pagination links antd renders for a page count this large. */
const PAGE_LINK_COUNT = 6;

testWithAssets(
  'opens the drill to detail modal from the chart menu',
  async ({ page, testAssets }) => {
    testWithAssets.setTimeout(TIMEOUT.SLOW_TEST);
    const { charts } = await openDrillDashboard(page, testAssets, [
      'big_number_total',
    ]);
    const [chart] = charts;

    await chart.getByLabel('More Options').click();
    await page
      .getByRole('menuitem', { name: 'Drill to detail', exact: true })
      .click();

    const modal = new DrillToDetailModal(page);
    await modal.waitForSamples({ timeout: TIMEOUT.CHART_RENDER });
    await expect(modal.title).toContainText('Drill to detail:');
    await expect(modal.rowCount).toContainText(ALL_ROWS);
  },
);

testWithAssets(
  'refreshes the drilled samples',
  async ({ page, testAssets }) => {
    testWithAssets.setTimeout(TIMEOUT.SLOW_TEST);
    const { charts } = await openDrillDashboard(page, testAssets, [
      'big_number_total',
    ]);
    const [chart] = charts;

    await chart.getByLabel('More Options').click();
    await page
      .getByRole('menuitem', { name: 'Drill to detail', exact: true })
      .click();

    const modal = new DrillToDetailModal(page);
    await modal.waitForSamples({ timeout: TIMEOUT.CHART_RENDER });
    await modal.gotoPage(PAGE_LINK_COUNT - 1);
    await expect(modal.activePage).not.toHaveText('1');

    await modal.reload();

    await expect(modal.activePage).toHaveText('1');
  },
);

testWithAssets(
  'paginates the drilled samples',
  async ({ page, testAssets }) => {
    testWithAssets.setTimeout(TIMEOUT.SLOW_TEST);
    const { charts } = await openDrillDashboard(page, testAssets, [
      'big_number_total',
    ]);
    const [chart] = charts;

    await chart.getByLabel('More Options').click();
    await page
      .getByRole('menuitem', { name: 'Drill to detail', exact: true })
      .click();

    const modal = new DrillToDetailModal(page);
    await modal.waitForSamples({ timeout: TIMEOUT.CHART_RENDER });
    await expect(modal.rowCount).toContainText(ALL_ROWS);
    await expect(modal.cells.first()).toBeVisible();
    await expect(modal.pages).toHaveCount(PAGE_LINK_COUNT);
    await expect(modal.pages.filter({ hasText: '1' }).first()).toBeVisible();
    await expect(
      modal.pages.filter({ hasText: ALL_ROWS_LAST_PAGE }),
    ).toHaveCount(1);
    // The samples query has no ordering of its own, so a page is identified by
    // the cells it renders rather than by a value of the example data.
    const renderedCells = () => modal.cells.allInnerTexts();
    const firstPage = await renderedCells();

    // Paginate deep enough for the rows to change, then back to the first page.
    await modal.gotoPage(4);
    await expect.poll(renderedCells).not.toEqual(firstPage);

    // The virtualized grid scrolls back to the top when the page changes, so the
    // first page's cells are rendered again without scrolling.
    await modal.grid.first().evaluate(element => element.scrollTo(0, 200));
    await modal.gotoPage(0);
    await expect.poll(renderedCells).toEqual(firstPage);
  },
);

testWithAssets(
  'clears a drill filter and reloads the samples',
  async ({ page, testAssets }) => {
    testWithAssets.setTimeout(CANVAS_TEST_TIMEOUT);
    const { charts } = await openDrillDashboard(page, testAssets, ['box_plot']);
    const [chart] = charts;
    await chartCanvas(chart);

    const [box] = await findDrillMarks(page, chart, [
      values => values.includes(GENDERS[0]),
    ]);
    await drillMarkBy(page, box.point, GENDERS[0]);

    const modal = new DrillToDetailModal(page);
    await modal.waitForSamples({ timeout: TIMEOUT.CHART_RENDER });
    await expect(modal.filterValues.first()).toContainText(GENDERS[0]);
    await expect(modal.rowCount).toContainText(BOY_ROWS);
    await expect(modal.pages).toHaveCount(PAGE_LINK_COUNT);
    await expect(
      modal.pages.filter({ hasText: BOY_ROWS_LAST_PAGE }),
    ).toHaveCount(1);

    await modal.removeFilter();

    await expect(modal.filterValues).toHaveCount(0);
    await expect(modal.rowCount).toContainText(ALL_ROWS);
    await expect(modal.activePage).toHaveText('1');
    await expect(modal.pages).toHaveCount(PAGE_LINK_COUNT);
    await expect(
      modal.pages.filter({ hasText: ALL_ROWS_LAST_PAGE }),
    ).toHaveCount(1);
  },
);

testWithAssets(
  'drills a Big Number with no filters',
  async ({ page, testAssets }) => {
    testWithAssets.setTimeout(TIMEOUT.SLOW_TEST);
    const { charts } = await openDrillDashboard(page, testAssets, [
      'big_number_total',
    ]);
    const [chart] = charts;

    await chart.locator('.header-line').click({ button: 'right' });
    await drillToDetail(page);

    const modal = new DrillToDetailModal(page);
    await modal.waitForSamples({ timeout: TIMEOUT.CHART_RENDER });
    await expect(modal.filterValues).toHaveCount(0);
  },
);

testWithAssets(
  'drills a Big Number with Trendline by its number and its trendline',
  async ({ page, testAssets }) => {
    testWithAssets.setTimeout(CANVAS_TEST_TIMEOUT);
    const { charts } = await openDrillDashboard(page, testAssets, [
      'big_number',
    ]);
    const [chart] = charts;
    const modal = new DrillToDetailModal(page);

    await chart.locator('.header-line').click({ button: 'right' });
    await drillToDetail(page);
    await modal.waitForSamples({ timeout: TIMEOUT.CHART_RENDER });
    await expect(modal.filterValues).toHaveCount(0);
    await modal.close();

    await chartCanvas(chart);
    // The trendline's marks carry only the time value the point aggregates.
    const year = await drillChartMark(page, chart, value => YEAR.test(value));

    await modal.waitForSamples({ timeout: TIMEOUT.CHART_RENDER });
    await expect(modal.filterValues.first()).toContainText(year);
  },
);

testWithAssets(
  'drills a Table by the clicked dimension value',
  async ({ page, testAssets }) => {
    testWithAssets.setTimeout(TIMEOUT.SLOW_TEST);
    const { charts } = await openDrillDashboard(page, testAssets, ['table']);
    const [chart] = charts;
    const modal = new DrillToDetailModal(page);

    for (const gender of GENDERS) {
      await chart.getByText(gender, { exact: true }).first().click({
        button: 'right',
      });
      await drillBy(page, gender);
      await modal.waitForSamples({ timeout: TIMEOUT.CHART_RENDER });
      await expect(modal.filterValues.first()).toContainText(gender);
      await modal.close();
    }
  },
);

testWithAssets(
  'drills a Pivot Table by each dimension of the clicked cell',
  async ({ page, testAssets }) => {
    testWithAssets.setTimeout(TIMEOUT.SLOW_TEST);
    const { charts } = await openDrillDashboard(page, testAssets, [
      'pivot_table_v2',
    ]);
    const [chart] = charts;
    const modal = new DrillToDetailModal(page);
    const cell = chart.getByRole('gridcell').first();

    // A pivot cell sits at the intersection of a row and a column dimension,
    // so it offers a drill by either, or by both at once.
    const values = await drillByValuesAt(page, cell);
    expect(values).toHaveLength(3);
    expect(values[2]).toBe('all');
    await page.keyboard.press('Escape');

    for (const value of values.slice(0, 2)) {
      await cell.click({ button: 'right' });
      await drillBy(page, value);
      await modal.waitForSamples({ timeout: TIMEOUT.CHART_RENDER });
      await expect(modal.filterValues.first()).toContainText(value);
      await modal.close();
    }

    await cell.click({ button: 'right' });
    await drillBy(page, 'all');
    await modal.waitForSamples({ timeout: TIMEOUT.CHART_RENDER });
    await expect(modal.filterValues).toHaveCount(2);
    // The modal groups the filters by dimension, which need not follow the
    // order the submenu listed them in.
    expect((await modal.filterValues.allInnerTexts()).sort()).toEqual(
      values.slice(0, 2).sort(),
    );
  },
);

/**
 * Time-series charts: every one of them draws marks per (time, gender) pair, so
 * a right-clicked mark can be drilled by its time value, by its gender, or by
 * both at once.
 */
const TIME_CHARTS = [
  'echarts_timeseries_line',
  'echarts_timeseries_bar',
  'echarts_area',
  'echarts_timeseries_scatter',
  'echarts_timeseries',
  'echarts_timeseries_smooth',
  'echarts_timeseries_step',
  'mixed_timeseries',
] as const;

for (const vizType of TIME_CHARTS) {
  testWithAssets(
    `drills ${vizType} by time, by dimension and by all`,
    async ({ page, testAssets }) => {
      testWithAssets.setTimeout(CANVAS_TEST_TIMEOUT);
      const { charts } = await openDrillDashboard(page, testAssets, [vizType]);
      const [chart] = charts;
      await chartCanvas(chart);
      const modal = new DrillToDetailModal(page);

      // The mark's own submenu names the time value it holds; a hard-coded one
      // would only hold for a specific pixel offset.
      const [{ point }] = await findDrillMarks(page, chart, [
        markValues =>
          markValues.length === 3 &&
          YEAR.test(markValues[0]) &&
          markValues[1] === GENDERS[0] &&
          markValues[2] === 'all',
      ]);

      const time = await drillMarkMatching(page, point, value =>
        YEAR.test(value),
      );
      await modal.waitForSamples({ timeout: TIMEOUT.CHART_RENDER });
      await expect(modal.filterValues.first()).toContainText(time);
      await modal.close();

      await drillMarkBy(page, point, GENDERS[0]);
      await modal.waitForSamples({ timeout: TIMEOUT.CHART_RENDER });
      await expect(modal.filterValues.first()).toContainText(GENDERS[0]);
      await modal.close();

      await drillMarkBy(page, point, 'all');
      await modal.waitForSamples({ timeout: TIMEOUT.CHART_RENDER });
      // The point can resolve to either of the neighbouring times, so the
      // filter is asserted to hold a time rather than one specific year.
      await expect(modal.filterValues.nth(0)).toContainText(YEAR);
      await expect(modal.filterValues.nth(1)).toContainText(GENDERS[0]);
    },
  );
}

/**
 * Charts whose marks carry a single dimension: each gender is a slice, bar,
 * box, tile or gauge of its own.
 */
const CATEGORICAL_CHARTS = [
  'pie',
  'funnel',
  'gauge_chart',
  'treemap_v2',
  'box_plot',
] as const;

for (const vizType of CATEGORICAL_CHARTS) {
  testWithAssets(
    `drills ${vizType} by the dimension value of each mark`,
    async ({ page, testAssets }) => {
      testWithAssets.setTimeout(CANVAS_TEST_TIMEOUT);
      const { charts } = await openDrillDashboard(page, testAssets, [vizType]);
      const [chart] = charts;
      await chartCanvas(chart);
      const modal = new DrillToDetailModal(page);

      const marks = await findDrillMarks(
        page,
        chart,
        GENDERS.map(gender => (values: string[]) => values.includes(gender)),
      );
      for (const [index, gender] of GENDERS.entries()) {
        await drillMarkBy(page, marks[index].point, gender);
        await modal.waitForSamples({ timeout: TIMEOUT.CHART_RENDER });
        await expect(modal.filterValues.first()).toContainText(gender);
        await modal.close();
      }
    },
  );
}
