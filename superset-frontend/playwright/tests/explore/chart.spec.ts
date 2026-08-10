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
 * Explore's cross-referenced dashboards: the metadata bar's dashboard count and
 * the "On dashboards" submenu of the chart's actions menu.
 *
 * Ported from the Cypress suite `cypress/e2e/explore/chart.test.js`.
 */
import type { Locator, Page } from '@playwright/test';
import { testWithAssets, expect } from '../../helpers/fixtures';
import { apiPostChart, apiPutChart } from '../../helpers/api/chart';
import { apiPostDashboard } from '../../helpers/api/dashboard';
import { getDatasetByName } from '../../helpers/api/dataset';
import { extractIdFromResponse } from '../../helpers/api/assertions';
import { ChartListPage } from '../../pages/ChartListPage';
import { ExplorePage } from '../../pages/ExplorePage';
import { TIMEOUT } from '../../utils/constants';

/**
 * Dashboards to attach the chart to. The submenu only renders its search box
 * past a threshold of ten dashboards, so eleven are needed to cover searching.
 */
const DASHBOARD_COUNT = 11;

const DATASET_NAME = 'birth_names';

/** Actions menu of the chart being explored, and its "On dashboards" submenu. */
async function openDashboardsSubmenu(page: Page): Promise<Locator> {
  const trigger = page.locator('[data-test="actions-trigger"]');
  await expect(trigger).toBeVisible();
  await trigger.click();
  // Dispatching the event leaves the pointer where it is, which is what keeps
  // the submenu open while its contents are read.
  await page
    .locator('.ant-dropdown-menu-submenu-title')
    .filter({ hasText: 'On dashboards' })
    .dispatchEvent('mouseover');
  const submenu = page
    .locator('.ant-dropdown-menu-submenu-popup:visible')
    .first();
  await submenu.waitFor({ state: 'visible' });
  // Keeping the pointer over the popup is what holds it open.
  await submenu.dispatchEvent('mouseover');
  return submenu;
}

async function closeDashboardsSubmenu(page: Page): Promise<void> {
  await page
    .locator('.ant-dropdown-menu-submenu-title')
    .filter({ hasText: 'On dashboards' })
    .dispatchEvent('mouseout');
  // The actions menu is a toggle, and an open dropdown holds the rest of the
  // page inert.
  await page.locator('[data-test="actions-trigger"]').click();
  await expect(
    page.locator('.ant-dropdown-menu-submenu-popup:visible'),
  ).toHaveCount(0);
}

/** Saves the explored chart onto an existing dashboard through the save modal. */
async function saveChartToDashboard(
  page: Page,
  chartName: string,
  dashboardName: string,
): Promise<void> {
  const saveButton = page.locator('[data-test="query-save-button"]');
  await expect(saveButton).toBeEnabled();

  const modal = page.locator('[data-test="save-modal-body"]');
  const dashboardSelect = page
    .locator('[data-test="save-chart-modal-select-dashboard-form"]')
    .getByRole('combobox');
  // Explore re-renders as it settles, which discards an open modal, so the
  // modal is filled in as a unit and reopened if it was discarded.
  await expect(async () => {
    if (!(await modal.isVisible())) {
      await saveButton.click();
    }
    await expect(dashboardSelect).toBeVisible({ timeout: 5000 });
    await dashboardSelect.click({ force: true, timeout: 5000 });
    await dashboardSelect.fill(dashboardName, { timeout: 5000 });
    // The option's title holds the full name, which distinguishes dashboards
    // whose names are prefixes of one another.
    await page
      .locator(`.ant-select-item-option[title="${dashboardName}"]`)
      .click({ timeout: 5000 });
  }).toPass({ timeout: TIMEOUT.API_RESPONSE * 4 });
  // Saving replaces the Explore URL, which refetches the chart's state; a
  // second save started before that lands is dropped with the modal.
  const exploreRefetched = page.waitForResponse(
    response => response.url().includes('/api/v1/explore/'),
    { timeout: TIMEOUT.API_RESPONSE },
  );
  // Toasts fade out on their own, so both are awaited from the moment the save
  // starts rather than one after the other.
  const toasts = Promise.all(
    [
      `was added to dashboard [${dashboardName}]`,
      `Chart [${chartName}] has been overwritten`,
    ].map(text =>
      page
        .getByText(text)
        .first()
        .waitFor({ state: 'visible', timeout: TIMEOUT.API_RESPONSE * 2 }),
    ),
  );
  await page.locator('[data-test="btn-modal-save"]').click();

  await expect(modal).toBeHidden({ timeout: TIMEOUT.API_RESPONSE });
  await toasts;
  await expect(saveButton).toBeEnabled({ timeout: TIMEOUT.API_RESPONSE });
  await exploreRefetched;
}

testWithAssets(
  'shows the dashboards a chart has been added to',
  async ({ page, testAssets }) => {
    // Eleven round trips through the save modal, each reloading Explore.
    testWithAssets.setTimeout(TIMEOUT.SLOW_TEST * 15);

    const dataset = await getDatasetByName(page, DATASET_NAME);
    if (!dataset) {
      throw new Error(`Dataset ${DATASET_NAME} not found`);
    }
    const suffix = Date.now();
    const chartName = `sample chart ${suffix}`;
    const chartResponse = await apiPostChart(page, {
      slice_name: chartName,
      viz_type: 'table',
      datasource_id: dataset.id,
      datasource_type: 'table',
      params: JSON.stringify({
        datasource: `${dataset.id}__table`,
        viz_type: 'table',
        query_mode: 'aggregate',
        groupby: ['gender'],
        metrics: ['count'],
        row_limit: 100,
      }),
    });
    expect(chartResponse.ok()).toBe(true);
    const chartId = await extractIdFromResponse(chartResponse);
    testAssets.trackChart(chartId);

    const dashboardNames: string[] = [];
    const dashboardIds: number[] = [];
    for (let index = 1; index <= DASHBOARD_COUNT; index += 1) {
      const dashboardTitle = `${index} - sample dashboard ${suffix}`;
      const dashboardResponse = await apiPostDashboard(page, {
        dashboard_title: dashboardTitle,
        published: true,
      });
      expect(dashboardResponse.ok()).toBe(true);
      const dashboardId = await extractIdFromResponse(dashboardResponse);
      testAssets.trackDashboard(dashboardId);
      dashboardIds.push(dashboardId);
      dashboardNames.push(dashboardTitle);
    }

    // Reach Explore the way a user does, from the chart list.
    const chartListPage = new ChartListPage(page);
    await chartListPage.goto();
    await chartListPage.waitForTableLoad();
    await page.getByRole('link', { name: chartName }).click();
    const explorePage = new ExplorePage(page);
    await explorePage.waitForPageLoad({ timeout: TIMEOUT.CHART_RENDER });

    const metadataBar = page.locator('[data-test="metadata-bar"]');
    await expect(metadataBar).toContainText('Not added to any dashboard');
    let submenu = await openDashboardsSubmenu(page);
    await expect(submenu).toContainText('None');
    await closeDashboardsSubmenu(page);

    // The save modal is the user-facing way to attach a chart to a dashboard.
    await saveChartToDashboard(page, chartName, dashboardNames[0]);
    await expect(metadataBar).toContainText('Added to 1 dashboard');
    submenu = await openDashboardsSubmenu(page);
    await expect(submenu).toContainText(dashboardNames[0]);
    await closeDashboardsSubmenu(page);

    // The remaining dashboards are attached through the API: the assertions
    // under test are the metadata bar's count and the submenu's entries, and
    // driving the save modal for each of them only repeats the save flow.
    for (let count = 2; count <= DASHBOARD_COUNT; count += 1) {
      const updateResponse = await apiPutChart(page, chartId, {
        dashboards: dashboardIds.slice(0, count),
      });
      expect(updateResponse.ok()).toBe(true);
      await explorePage.goto(chartId, { timeout: TIMEOUT.CHART_RENDER });
      await expect(metadataBar).toContainText(`Added to ${count} dashboards`);
      submenu = await openDashboardsSubmenu(page);
      for (const dashboardName of dashboardNames.slice(0, count)) {
        await expect(submenu).toContainText(dashboardName);
      }
      await closeDashboardsSubmenu(page);
    }

    // Past the threshold the submenu offers a search box.
    submenu = await openDashboardsSubmenu(page);
    // The search box lives in a menu item that antd marks disabled to keep
    // clicks in it from closing the menu, so it fails the editability check.
    const search = submenu.locator('input[placeholder="Search"]');
    await search.fill('1 - ', { force: true });
    await expect(submenu).toContainText(dashboardNames[0]);
    await search.fill('Blahblah', { force: true });
    await expect(submenu).toContainText('No results found');
    await submenu.locator('[aria-label="close-circle"]').click({ force: true });
    await expect(submenu).toContainText(dashboardNames[0]);
    await closeDashboardsSubmenu(page);

    // Each entry links to its dashboard.
    submenu = await openDashboardsSubmenu(page);
    const [dashboardTab] = await Promise.all([
      page.waitForEvent('popup'),
      submenu.locator('a').first().dispatchEvent('click'),
    ]);
    await expect(
      dashboardTab.locator('[data-test="dashboard-header-container"]'),
    ).toBeVisible({ timeout: TIMEOUT.PAGE_LOAD });
  },
);

testWithAssets(
  'shows a no results message when a query returns nothing',
  async ({ page, testAssets }) => {
    const dataset = await getDatasetByName(page, DATASET_NAME);
    if (!dataset) {
      throw new Error(`Dataset ${DATASET_NAME} not found`);
    }
    const chartResponse = await apiPostChart(page, {
      slice_name: `no results ${Date.now()}`,
      viz_type: 'echarts_timeseries_line',
      datasource_id: dataset.id,
      datasource_type: 'table',
      params: JSON.stringify({
        datasource: `${dataset.id}__table`,
        viz_type: 'echarts_timeseries_line',
        x_axis: 'ds',
        time_grain_sqla: 'P1Y',
        metrics: ['sum__num'],
        adhoc_filters: [
          {
            expressionType: 'SIMPLE',
            subject: 'state',
            operator: 'IN',
            comparator: ['Fake State'],
            clause: 'WHERE',
          },
        ],
        row_limit: 100,
      }),
    });
    expect(chartResponse.ok()).toBe(true);
    const chartId = await extractIdFromResponse(chartResponse);
    testAssets.trackChart(chartId);

    const explorePage = new ExplorePage(page);
    await explorePage.goto(chartId, { timeout: TIMEOUT.CHART_RENDER });

    await expect(explorePage.getChartContainer()).toContainText(
      'No results were returned for this query',
      { timeout: TIMEOUT.CHART_RENDER },
    );
  },
);
