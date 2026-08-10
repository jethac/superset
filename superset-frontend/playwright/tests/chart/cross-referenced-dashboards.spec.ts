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

import type { Page } from '@playwright/test';
import {
  testWithAssets,
  expect,
  type TestAssets,
} from '../../helpers/fixtures';
import { ExplorePage } from '../../pages/ExplorePage';
import { apiPostDashboard } from '../../helpers/api/dashboard';
import { apiPutChart } from '../../helpers/api/chart';
import { extractIdFromResponse } from '../../helpers/api/assertions';
import { createTestChart } from './chart-test-helpers';
import { TIMEOUT } from '../../utils/constants';

/**
 * The submenu only renders its search box above SEARCH_THRESHOLD dashboards
 * (src/explore/components/useExploreAdditionalActionsMenu/index.tsx).
 */
const SEARCH_THRESHOLD = 10;
const DASHBOARD_COUNT = SEARCH_THRESHOLD + 1;

const test = testWithAssets;

async function createDashboards(
  page: Page,
  testAssets: TestAssets,
  titles: string[],
): Promise<number[]> {
  const ids: number[] = [];
  for (const dashboard_title of titles) {
    // Sequential: the dashboards are cheap to create and a burst of parallel
    // POSTs competes with the single-worker backend used in CI.
    // eslint-disable-next-line no-await-in-loop
    const response = await apiPostDashboard(page, { dashboard_title });
    // eslint-disable-next-line no-await-in-loop
    const id = await extractIdFromResponse(response);
    testAssets.trackDashboard(id);
    ids.push(id);
  }
  return ids;
}

test('should show the dashboards a chart is on', async ({
  page,
  testAssets,
}) => {
  test.setTimeout(TIMEOUT.SLOW_TEST);

  const prefix = `xref_${Date.now()}_${test.info().parallelIndex}`;
  const titles = Array.from(
    { length: DASHBOARD_COUNT },
    (_, index) => `${prefix} dashboard ${index + 1}`,
  );
  const dashboardIds = await createDashboards(page, testAssets, titles);
  const { id: chartId } = await createTestChart(page, testAssets, test.info(), {
    prefix: 'xref_chart',
  });

  const explorePage = new ExplorePage(page);
  await explorePage.goto(chartId);

  // A chart on no dashboards reports so in the metadata bar and the submenu.
  await expect(explorePage.getMetadataBar()).toContainText(
    'Not added to any dashboard',
  );
  let submenu = await explorePage.openDashboardsSubmenu();
  await expect(submenu).toContainText('None');
  await explorePage.closeActionsMenu();

  // Adding the chart to a dashboard through the save modal updates both.
  await explorePage.saveChartToDashboard(titles[0]);
  await expect(explorePage.getMetadataBar()).toContainText(
    'Added to 1 dashboard',
  );
  submenu = await explorePage.openDashboardsSubmenu();
  await expect(submenu).toContainText(titles[0]);
  await explorePage.closeActionsMenu();

  // The remaining dashboards go on via the API: the save modal path is already
  // covered above, and this keeps the run short enough for CI.
  const putResponse = await apiPutChart(page, chartId, {
    dashboards: dashboardIds,
  });
  expect(putResponse.ok()).toBe(true);

  await explorePage.goto(chartId);
  await expect(explorePage.getMetadataBar()).toContainText(
    `Added to ${DASHBOARD_COUNT} dashboards`,
  );

  // Past the threshold the submenu gains a search box that filters the list.
  submenu = await explorePage.openDashboardsSubmenu();
  const searchInput = submenu.locator('input[placeholder="Search"]');
  await expect(searchInput).toBeVisible();

  await searchInput.fill(titles[6]);
  await expect(submenu).toContainText(titles[6]);
  await expect(submenu).not.toContainText(titles[2]);

  await searchInput.fill('Blahblah');
  await expect(submenu).toContainText('No results found');

  await submenu.locator('[aria-label="close-circle"]').click();
  await expect(submenu).toContainText(titles[0]);
  await explorePage.closeActionsMenu();
});

test('should link from the submenu to a dashboard the chart is on', async ({
  page,
  testAssets,
}) => {
  const dashboardTitle = `xref_link_${Date.now()}_${test.info().parallelIndex}`;
  const [dashboardId] = await createDashboards(page, testAssets, [
    dashboardTitle,
  ]);
  const { id: chartId } = await createTestChart(page, testAssets, test.info(), {
    prefix: 'xref_link_chart',
  });
  const putResponse = await apiPutChart(page, chartId, {
    dashboards: [dashboardId],
  });
  expect(putResponse.ok()).toBe(true);

  const explorePage = new ExplorePage(page);
  await explorePage.goto(chartId);

  const submenu = await explorePage.openDashboardsSubmenu();
  const [dashboardTab] = await Promise.all([
    page.waitForEvent('popup'),
    submenu.getByRole('link', { name: dashboardTitle }).click(),
  ]);

  await expect(dashboardTab).toHaveURL(
    new RegExp(`/dashboard/${dashboardId}\\b`),
  );
  await dashboardTab.close();
});
