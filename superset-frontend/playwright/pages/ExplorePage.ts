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

import { Page, Locator } from '@playwright/test';
import { TIMEOUT } from '../utils/constants';
import { AgGrid } from '../components/core/AgGrid';
import { Menu, Select } from '../components/core';

/**
 * Explore Page object
 */
export class ExplorePage {
  private readonly page: Page;

  private static readonly SELECTORS = {
    DATASOURCE_CONTROL: '[data-test="datasource-control"]',
    VIZ_SWITCHER: '[data-test="fast-viz-switcher"]',
    CHART_CONTAINER: '[data-test="chart-container"]',
    // The bottom data panel (DataTablesPane / SouthPane) with Results/Samples tabs
    SOUTH_PANE: '[data-test="some-purposeful-instance"]',
    EXPAND_DATA_PANEL: '[aria-label="Expand data panel"]',
    RESULTS_TAB: '[data-node-key="results"]',
    ACTIVE_TABPANE: '.ant-tabs-content-active',
    METADATA_BAR: '[data-test="metadata-bar"]',
    ACTIONS_TRIGGER: '[data-test="actions-trigger"]',
    // The additional-actions menu is rendered into an unlabelled portal, so the
    // open dropdown is the only handle on it.
    OPEN_DROPDOWN: '.ant-dropdown:not(.ant-dropdown-hidden)',
    SAVE_BUTTON: '[data-test="query-save-button"]',
    SAVE_MODAL_BODY: '[data-test="save-modal-body"]',
    SAVE_MODAL_CONFIRM: '[data-test="btn-modal-save"]',
  } as const;

  /** Label of the submenu listing the dashboards a chart has been added to. */
  private static readonly DASHBOARDS_SUBMENU = 'On dashboards';

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Navigates to the Explore page for a given chart and waits for it to load.
   *
   * @param chartId - ID of the chart (slice) to open
   * @param options - Optional wait options
   */
  async goto(chartId: number, options?: { timeout?: number }): Promise<void> {
    await this.page.goto(`explore/?slice_id=${chartId}`);
    await this.waitForPageLoad(options);
  }

  /**
   * Gets the chart container locator (where the rendered viz appears).
   *
   * @returns Locator for the chart container
   */
  getChartContainer(): Locator {
    return this.page.locator(ExplorePage.SELECTORS.CHART_CONTAINER);
  }

  /**
   * Waits for the Explore page to load.
   * Validates URL contains /explore/ and datasource control is visible.
   *
   * @param options - Optional wait options
   */
  async waitForPageLoad(options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? TIMEOUT.PAGE_LOAD;

    await this.page.waitForURL('**/explore/**', { timeout });

    await this.page.waitForSelector(ExplorePage.SELECTORS.DATASOURCE_CONTROL, {
      state: 'visible',
      timeout,
    });
  }

  /**
   * Gets the datasource control locator.
   * Returns a Locator that tests can use with expect() or to read text.
   *
   * @returns Locator for the datasource control
   *
   * @example
   * const name = await explorePage.getDatasourceControl().textContent();
   */
  getDatasourceControl(): Locator {
    return this.page.locator(ExplorePage.SELECTORS.DATASOURCE_CONTROL);
  }

  /**
   * Gets the currently selected dataset name from the datasource control
   */
  async getDatasetName(): Promise<string> {
    const text = await this.getDatasourceControl().textContent();
    return text?.trim() || '';
  }

  /**
   * Gets the visualization switcher locator.
   * Returns a Locator that tests can use with expect().toBeVisible(), etc.
   *
   * @returns Locator for the viz switcher
   *
   * @example
   * await expect(explorePage.getVizSwitcher()).toBeVisible();
   */
  getVizSwitcher(): Locator {
    return this.page.locator(ExplorePage.SELECTORS.VIZ_SWITCHER);
  }

  /**
   * Expands the bottom data panel if it is currently collapsed.
   * Safe to call when already expanded (no-op).
   */
  async expandDataPanel(): Promise<void> {
    const expandButton = this.page.locator(
      ExplorePage.SELECTORS.EXPAND_DATA_PANEL,
    );
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
  }

  /**
   * Opens the bottom data panel and activates the "Results" tab. Clicking the
   * already-active tab collapses the panel, so the click is guarded.
   */
  async openResultsTab(): Promise<void> {
    await this.expandDataPanel();
    const resultsTab = this.page
      .locator(ExplorePage.SELECTORS.SOUTH_PANE)
      .locator(ExplorePage.SELECTORS.RESULTS_TAB);
    const className = (await resultsTab.getAttribute('class')) ?? '';
    if (!className.includes('ant-tabs-tab-active')) {
      await resultsTab.click();
    }
  }

  /**
   * Returns an AgGrid wrapper around the currently active Results tab grid.
   */
  getResultsGrid(): AgGrid {
    const grid = this.page
      .locator(ExplorePage.SELECTORS.SOUTH_PANE)
      .locator(ExplorePage.SELECTORS.ACTIVE_TABPANE)
      .locator('[role="grid"]')
      .first();
    return new AgGrid(this.page, grid);
  }

  /**
   * The metadata bar under the chart title, which summarises dashboard
   * membership, last modification and authorship.
   */
  getMetadataBar(): Locator {
    return this.page.locator(ExplorePage.SELECTORS.METADATA_BAR);
  }

  /**
   * Opens the additional-actions dropdown in the Explore header.
   */
  async openActionsMenu(): Promise<void> {
    await this.page.locator(ExplorePage.SELECTORS.ACTIONS_TRIGGER).click();
    await this.page
      .locator(ExplorePage.SELECTORS.OPEN_DROPDOWN)
      .first()
      .waitFor({ state: 'visible' });
  }

  /**
   * Closes the additional-actions dropdown by clicking its trigger again.
   */
  async closeActionsMenu(): Promise<void> {
    await this.page.locator(ExplorePage.SELECTORS.ACTIONS_TRIGGER).click();
    await this.page
      .locator(ExplorePage.SELECTORS.OPEN_DROPDOWN)
      .first()
      .waitFor({ state: 'hidden' });
  }

  /**
   * Opens the additional-actions menu and hovers its "On dashboards" submenu.
   *
   * @param expectedItemText - Text the submenu is expected to contain, used to
   * identify the popup among any other open ones
   * @returns Locator for the submenu popup
   */
  async openDashboardsSubmenu(expectedItemText: string): Promise<Locator> {
    await this.openActionsMenu();
    const menu = new Menu(this.page, ExplorePage.SELECTORS.OPEN_DROPDOWN);
    return menu.openSubmenu(ExplorePage.DASHBOARDS_SUBMENU, expectedItemText, {
      timeout: TIMEOUT.UI_TRANSITION,
    });
  }

  /**
   * Saves the current chart onto an existing dashboard, overwriting the chart.
   *
   * Returns once the save modal has closed; the save is complete when the chart
   * PUT resolves, which callers await alongside this call.
   *
   * @param dashboardName - Title of the dashboard to add the chart to
   */
  async saveChartToDashboard(dashboardName: string): Promise<void> {
    const saveButton = this.page.locator(ExplorePage.SELECTORS.SAVE_BUTTON);
    await saveButton.click();

    const modalBody = this.page.locator(ExplorePage.SELECTORS.SAVE_MODAL_BODY);
    await modalBody.waitFor({ state: 'visible' });

    const dashboardSelect = Select.fromRole(this.page, 'Select a dashboard');
    await dashboardSelect.selectOption(dashboardName);

    await this.page.locator(ExplorePage.SELECTORS.SAVE_MODAL_CONFIRM).click();
    await modalBody.waitFor({ state: 'detached' });
  }

  /**
   * The Explore header's save button, whose enabled state tracks whether the
   * chart has unsaved changes.
   */
  getSaveButton(): Locator {
    return this.page.locator(ExplorePage.SELECTORS.SAVE_BUTTON);
  }
}
