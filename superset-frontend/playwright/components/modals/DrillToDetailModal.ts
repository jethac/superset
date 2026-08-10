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

import { Locator, Page } from '@playwright/test';
import { Modal } from '../core';

/**
 * The Drill to detail modal, showing the sample rows behind a chart's data
 * point together with the filters that point drilled by.
 *
 * Identified by its Close button: the modal itself carries no test id, and a
 * dashboard can hold other dialogs.
 */
export class DrillToDetailModal extends Modal {
  private static readonly SELECTORS = {
    CLOSE_BUTTON: '[data-test="close-drilltodetail-modal"]',
    TITLE: '.draggable-trigger',
    FILTER_TAG: '[data-test="filter-col"]',
    FILTER_VALUE: '[data-test="filter-val"]',
    ROW_COUNT: '[data-test="row-count-label"]',
    METADATA_BAR: '[data-test="metadata-bar"]',
    CELL: '.virtual-table-cell',
    GRID: '.virtual-grid',
    PAGE: '.ant-pagination-item',
    ACTIVE_PAGE: '.ant-pagination-item-active',
  } as const;

  constructor(page: Page) {
    super(page, `.ant-modal:has(${DrillToDetailModal.SELECTORS.CLOSE_BUTTON})`);
  }

  /** Modal title, which names the chart being drilled into. */
  get title(): Locator {
    return this.element.locator(DrillToDetailModal.SELECTORS.TITLE);
  }

  /** Dataset metadata strip, rendered once the samples request resolves. */
  get metadataBar(): Locator {
    return this.element.locator(DrillToDetailModal.SELECTORS.METADATA_BAR);
  }

  /** Values of the filters the drill applied, in the order they are shown. */
  get filterValues(): Locator {
    return this.element.locator(DrillToDetailModal.SELECTORS.FILTER_VALUE);
  }

  /** Total row count of the filtered samples. */
  get rowCount(): Locator {
    return this.element.locator(DrillToDetailModal.SELECTORS.ROW_COUNT);
  }

  /** Cells of the samples table. */
  get cells(): Locator {
    return this.element.locator(DrillToDetailModal.SELECTORS.CELL);
  }

  /** Scrollable viewport of the virtualized samples table. */
  get grid(): Locator {
    return this.element.locator(DrillToDetailModal.SELECTORS.GRID);
  }

  /** Page links of the samples table's pagination. */
  get pages(): Locator {
    return this.element.locator(DrillToDetailModal.SELECTORS.PAGE);
  }

  /** The pagination link of the page currently shown. */
  get activePage(): Locator {
    return this.element.locator(DrillToDetailModal.SELECTORS.ACTIVE_PAGE);
  }

  /** Waits for the modal and its samples to be shown. */
  async waitForSamples(options?: { timeout?: number }): Promise<void> {
    await this.metadataBar.waitFor({ state: 'visible', ...options });
  }

  /** Clicks a pagination link by its zero-based position. */
  async gotoPage(index: number): Promise<void> {
    await this.pages.nth(index).click();
  }

  /** Reloads the samples. */
  async reload(): Promise<void> {
    await this.element.getByLabel('Reload').click();
  }

  /** Removes the drill filter at the given position. */
  async removeFilter(index = 0): Promise<void> {
    await this.element
      .locator(DrillToDetailModal.SELECTORS.FILTER_TAG)
      .nth(index)
      .getByLabel('Close')
      .click();
  }

  /** Closes the modal. */
  async close(): Promise<void> {
    await this.element
      .locator(DrillToDetailModal.SELECTORS.CLOSE_BUTTON)
      .click();
    await this.element.waitFor({ state: 'hidden' });
  }
}
