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
 * Explore's cross-referenced dashboards: the metadata bar count and the
 * "On dashboards" submenu that together tell a chart's author where the chart
 * is used.
 *
 * Ported from cypress-base/cypress/e2e/explore/chart.test.js.
 *
 * The chart is added to eleven dashboards one at a time, because the submenu's
 * search box only renders above SEARCH_THRESHOLD (10) dashboards — the
 * eleventh save is what brings it into existence.
 */
import type { Locator } from '@playwright/test';
import { testWithAssets, expect } from '../../helpers/fixtures';
import { apiPostChart, apiPutChart, ENDPOINTS } from '../../helpers/api/chart';
import { apiPostDashboard } from '../../helpers/api/dashboard';
import { getDatasetByName } from '../../helpers/api/dataset';
import { extractIdFromResponse } from '../../helpers/api/assertions';
import { waitForGet, waitForPut } from '../../helpers/api/intercepts';
import { ChartListPage } from '../../pages/ChartListPage';
import { ExplorePage } from '../../pages/ExplorePage';
import { Toast } from '../../components/core';
import { TIMEOUT } from '../../utils/constants';

const DATASET_NAME = 'birth_names';

/**
 * SEARCH_THRESHOLD (src/explore/components/useExploreAdditionalActionsMenu) is
 * 10, so eleven dashboards are needed for the submenu's search box to render.
 */
const DASHBOARD_COUNT = 11;

/** Ant Design's portal for an open submenu. */
const SUBMENU_POPUP = '.ant-dropdown-menu-submenu-popup';

/** Placeholder of the submenu's search box, which has no test id. */
const SEARCH_INPUT = 'input[placeholder="Search"]';

/** Ant Design's clear button inside the search box. */
const SEARCH_CLEAR = '[aria-label="close-circle"]';

/**
 * Types into the submenu's search box.
 *
 * The box sits in a menu item marked disabled — that is how the menu keeps a
 * click on the box from closing itself — so the input fails Playwright's
 * enabled check and cannot be filled. Focusing it and typing goes through the
 * same keyboard path a user takes.
 */
async function searchDashboards(submenu: Locator, term: string): Promise<void> {
  const input = submenu.locator(SEARCH_INPUT);
  await input.focus();
  await input.press('ControlOrMeta+a');
  await input.pressSequentially(term);
}

testWithAssets(
  'Explore lists the dashboards a chart has been added to',
  async ({ page, testAssets }, testInfo) => {
    // Eleven sequential save round-trips, each reloading Explore's metadata.
    testWithAssets.setTimeout(TIMEOUT.SLOW_TEST * 10);

    const dataset = await getDatasetByName(page, DATASET_NAME);
    if (!dataset) {
      throw new Error(`Dataset ${DATASET_NAME} not found`);
    }

    // Parallel-safe suffix so names never collide across workers.
    const uniqueSuffix = `${Date.now()}_${testInfo.parallelIndex}`;
    const chartName = `1 - Sample chart ${uniqueSuffix}`;
    const dashboardName = (index: number) =>
      `${index} - Sample dashboard ${uniqueSuffix}`;

    const chartResponse = await apiPostChart(page, {
      slice_name: chartName,
      viz_type: 'echarts_timeseries_line',
      datasource_id: dataset.id,
      datasource_type: 'table',
      params: JSON.stringify({
        datasource: `${dataset.id}__table`,
        viz_type: 'echarts_timeseries_line',
        x_axis: 'ds',
        metrics: ['count'],
      }),
    });
    expect(chartResponse.ok()).toBe(true);
    const chartId = await extractIdFromResponse(chartResponse);
    testAssets.trackChart(chartId);

    const dashboardIds: number[] = [];
    for (let index = 1; index <= DASHBOARD_COUNT; index += 1) {
      const dashboardResponse = await apiPostDashboard(page, {
        dashboard_title: dashboardName(index),
        published: true,
      });
      expect(dashboardResponse.ok()).toBe(true);
      const dashboardId = await extractIdFromResponse(dashboardResponse);
      testAssets.trackDashboard(dashboardId);
      dashboardIds.push(dashboardId);
    }

    // Reach Explore the way a user does, through the chart list.
    const chartListPage = new ChartListPage(page);
    await chartListPage.goto();
    await chartListPage.waitForTableLoad();
    const chartRow = chartListPage.getChartRow(chartName);
    await expect(chartRow).toBeVisible({ timeout: TIMEOUT.API_RESPONSE });
    await chartRow.getByRole('link', { name: chartName }).click();

    const explorePage = new ExplorePage(page);
    const toast = new Toast(page);
    await explorePage.waitForPageLoad({ timeout: TIMEOUT.EXPLORE_PAGE_LOAD });

    // A chart on no dashboards reports so in both places.
    await expect(explorePage.getMetadataBar()).toContainText(
      'Not added to any dashboard',
    );
    let submenu = await explorePage.openDashboardsSubmenu('None');
    await expect(submenu).toContainText('None');
    await explorePage.closeActionsMenu();

    for (let index = 1; index <= DASHBOARD_COUNT; index += 1) {
      await expect(explorePage.getSaveButton()).toBeEnabled();

      const savePromise = waitForPut(page, `${ENDPOINTS.CHART}${chartId}`);
      // Explore refetches its metadata after a save; that response is what
      // repopulates the metadata bar and the submenu asserted on below.
      const explorePromise = waitForGet(page, /\/api\/v1\/explore\/\?/);
      await explorePage.saveChartToDashboard(dashboardName(index));
      await savePromise;
      await explorePromise;

      await expect(
        toast
          .get()
          .filter({
            hasText: `was added to dashboard [${dashboardName(index)}]`,
          })
          .first(),
      ).toBeVisible();
      await expect(
        toast
          .get()
          .filter({ hasText: `Chart [${chartName}] has been overwritten` })
          .first(),
      ).toBeVisible();
      // The chart reloads after a save, and saving is disabled while it does.
      await expect(explorePage.getSaveButton()).toBeEnabled();

      await expect(explorePage.getMetadataBar()).toContainText(
        index > 1 ? `Added to ${index} dashboards` : 'Added to 1 dashboard',
      );

      submenu = await explorePage.openDashboardsSubmenu(dashboardName(index));
      await expect(submenu).toContainText(dashboardName(index));
      await explorePage.closeActionsMenu();
    }

    // Above SEARCH_THRESHOLD the submenu filters its entries.
    await explorePage.openDashboardsSubmenu(dashboardName(1));
    // Addressed by the search box it contains: a term that matches nothing
    // empties the popup, so it cannot be addressed by a dashboard name.
    const searchPopup = page
      .locator(SUBMENU_POPUP)
      .filter({ has: page.locator(SEARCH_INPUT) });
    await searchDashboards(searchPopup, '1 - Sample');
    await expect(searchPopup).toContainText(dashboardName(1));
    await searchDashboards(searchPopup, 'Blahblah');
    await expect(searchPopup).toContainText('No results found');
    await searchPopup.locator(SEARCH_CLEAR).dispatchEvent('click');
    await expect(searchPopup).toContainText(dashboardName(1));
    await explorePage.closeActionsMenu();

    // Each entry links to its dashboard. The links open in a new tab, so the
    // navigation is asserted on the popup rather than on `page`.
    submenu = await explorePage.openDashboardsSubmenu(dashboardName(1));
    const [dashboardTab] = await Promise.all([
      page.context().waitForEvent('page'),
      submenu.getByRole('link').first().click(),
    ]);
    await dashboardTab.waitForLoadState();
    expect(dashboardIds).toContain(
      Number(
        new URL(dashboardTab.url()).pathname.split('/').filter(Boolean)[1],
      ),
    );
    await expect(
      dashboardTab.locator('[data-test="dashboard-header-container"]'),
    ).toBeVisible({ timeout: TIMEOUT.PAGE_LOAD });
    await dashboardTab.close();

    // Leave the chart off the dashboards so fixture cleanup order cannot matter.
    await apiPutChart(page, chartId, { dashboards: [] });
  },
);
