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
import { waitForPut } from '../helpers/api/intercepts';

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
    ACTIONS_TRIGGER: '[data-test="actions-trigger"]',
    METADATA_BAR: '[data-test="metadata-bar"]',
    SAVE_BUTTON: '[data-test="query-save-button"]',
    SAVE_MODAL_BODY: '[data-test="save-modal-body"]',
    SAVE_MODAL_SAVE_BUTTON: '[data-test="btn-modal-save"]',
    SUBMENU_TITLE: '.ant-dropdown-menu-submenu-title',
    SUBMENU_POPUP:
      '.ant-dropdown-menu-submenu-popup:not(.ant-dropdown-menu-submenu-hidden)',
  } as const;

  private static readonly DASHBOARDS_SUBMENU_LABEL = 'On dashboards';

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
   * Gets the metadata bar locator (chart header summary items).
   *
   * @returns Locator for the metadata bar
   */
  getMetadataBar(): Locator {
    return this.page.locator(ExplorePage.SELECTORS.METADATA_BAR);
  }

  /**
   * Opens the chart's additional actions dropdown.
   */
  async openActionsMenu(): Promise<void> {
    await this.page.locator(ExplorePage.SELECTORS.ACTIONS_TRIGGER).click();
  }

  /**
   * Closes the chart's additional actions dropdown, including any open submenu.
   */
  async closeActionsMenu(): Promise<void> {
    const popup = this.page
      .locator(ExplorePage.SELECTORS.SUBMENU_POPUP)
      .first();
    await this.page.keyboard.press('Escape');
    if (await popup.isVisible()) {
      // Escape only dismisses the search input in some Ant Design versions;
      // toggling the trigger closes the dropdown and its submenu.
      await this.page.locator(ExplorePage.SELECTORS.ACTIONS_TRIGGER).click();
    }
    await popup.waitFor({
      state: 'hidden',
      timeout: TIMEOUT.UI_TRANSITION,
    });
  }

  /**
   * Opens the actions dropdown and hovers the "On dashboards" submenu.
   *
   * @returns Locator for the submenu popup listing the chart's dashboards
   */
  async openDashboardsSubmenu(): Promise<Locator> {
    await this.openActionsMenu();
    await this.page
      .locator(ExplorePage.SELECTORS.SUBMENU_TITLE)
      .filter({ hasText: ExplorePage.DASHBOARDS_SUBMENU_LABEL })
      .hover();
    const popup = this.page.locator(ExplorePage.SELECTORS.SUBMENU_POPUP);
    await popup.waitFor({ state: 'visible', timeout: TIMEOUT.FORM_LOAD });
    return popup;
  }

  /**
   * Saves the current chart, overwriting it and adding it to a dashboard
   * through the save modal.
   *
   * @param dashboardName - Title of an existing dashboard to add the chart to
   */
  async saveChartToDashboard(dashboardName: string): Promise<void> {
    const saveButton = this.page.locator(ExplorePage.SELECTORS.SAVE_BUTTON);
    await saveButton.click();

    const modal = this.page.locator(ExplorePage.SELECTORS.SAVE_MODAL_BODY);
    await modal.waitFor({ state: 'visible', timeout: TIMEOUT.FORM_LOAD });

    const dashboardSelect = this.page.getByRole('combobox', {
      name: /select a dashboard/i,
    });
    await dashboardSelect.click();
    await this.page.keyboard.type(dashboardName);
    await this.page
      .locator(`.ant-select-item-option[title="${dashboardName}"]`)
      .click();

    const chartSaved = waitForPut(this.page, /\/api\/v1\/chart\/\d+$/, {
      timeout: TIMEOUT.API_RESPONSE,
    });
    await this.page
      .locator(ExplorePage.SELECTORS.SAVE_MODAL_SAVE_BUTTON)
      .click();
    await chartSaved;

    await modal.waitFor({ state: 'hidden', timeout: TIMEOUT.FORM_LOAD });
    await this.waitForPageLoad();
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
}
