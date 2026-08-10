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
import {
  CategoricalColorNamespace,
  ChartProps,
  QueryFormColumn,
  getLabelsColorMap,
  LabelsColorMapSource,
} from '@superset-ui/core';
import { supersetTheme } from '@apache-superset/core/theme';
import transformProps from '../../src/Sankey/transformProps';
import { SankeyChartProps } from '../../src/Sankey/types';

type SeriesDatum = { name: string; itemStyle: { color: string } };

const colorScheme = 'bnbColors';

const baseFormData = {
  colorScheme,
  datasource: '5__table',
  viz_type: 'sankey_v2',
  metric: 'count',
  source: 'stage_from',
  target: 'stage_to',
  slice_id: 1,
};

const rows = [
  {
    stage_from: 'bugfix ▸ triaged',
    stage_to: 'bugfix ▸ in review',
    stream: 'bugfix',
    count: 5,
  },
  {
    stage_from: 'bugfix ▸ in review',
    stage_to: 'bugfix ▸ merged',
    stream: 'bugfix',
    count: 3,
  },
  {
    stage_from: 'greenfield ▸ triaged',
    stage_to: 'greenfield ▸ in review',
    stream: 'greenfield',
    count: 7,
  },
];

function getSeriesData(
  data: Record<string, string | number>[],
  colorBy?: QueryFormColumn,
): SeriesDatum[] {
  const chartProps = new ChartProps({
    formData: { ...baseFormData, ...(colorBy ? { color_by: colorBy } : {}) },
    width: 800,
    height: 600,
    theme: supersetTheme,
    queriesData: [{ data }],
  });
  const { echartOptions } = transformProps(
    chartProps as unknown as SankeyChartProps,
  );
  const { series } = echartOptions;
  return (series as { data: SeriesDatum[] }).data;
}

function getColor(seriesData: SeriesDatum[], name: string): string {
  const node = seriesData.find(datum => datum.name === name);
  if (!node) {
    throw new Error(`node ${name} not found`);
  }
  return node.itemStyle.color;
}

beforeEach(() => {
  CategoricalColorNamespace.getNamespace().resetColors();
  getLabelsColorMap().clear();
  getLabelsColorMap().source = LabelsColorMapSource.Explore;
});

test('nodes are colored by their own name when color_by is unset', () => {
  const seriesData = getSeriesData(rows);
  const colorFn = CategoricalColorNamespace.getScale(colorScheme);
  seriesData.forEach(({ name, itemStyle }) => {
    expect(itemStyle.color).toEqual(colorFn(name));
  });
  expect(getColor(seriesData, 'bugfix ▸ triaged')).not.toEqual(
    getColor(seriesData, 'bugfix ▸ merged'),
  );
});

test('nodes of the same stream share a color when color_by is set', () => {
  const seriesData = getSeriesData(rows, 'stream');
  const colorFn = CategoricalColorNamespace.getScale(colorScheme);

  const bugfixColor = colorFn('bugfix');
  const greenfieldColor = colorFn('greenfield');

  ['bugfix ▸ triaged', 'bugfix ▸ in review', 'bugfix ▸ merged'].forEach(
    name => {
      expect(getColor(seriesData, name)).toEqual(bugfixColor);
    },
  );
  ['greenfield ▸ triaged', 'greenfield ▸ in review'].forEach(name => {
    expect(getColor(seriesData, name)).toEqual(greenfieldColor);
  });
  expect(bugfixColor).not.toEqual(greenfieldColor);
});

test('a shared node keeps the color key of the first row mentioning it', () => {
  const sharedRows = [
    { stage_from: 'bugfix', stage_to: 'shipped', stream: 'bugfix', count: 5 },
    {
      stage_from: 'greenfield',
      stage_to: 'shipped',
      stream: 'greenfield',
      count: 7,
    },
  ];
  const seriesData = getSeriesData(sharedRows, 'stream');

  expect(getColor(seriesData, 'shipped')).toEqual(
    getColor(seriesData, 'bugfix'),
  );
  expect(getColor(seriesData, 'shipped')).not.toEqual(
    getColor(seriesData, 'greenfield'),
  );
});

test('reversing the rows moves the shared node to the other stream color', () => {
  const sharedRows = [
    {
      stage_from: 'greenfield',
      stage_to: 'shipped',
      stream: 'greenfield',
      count: 7,
    },
    { stage_from: 'bugfix', stage_to: 'shipped', stream: 'bugfix', count: 5 },
  ];
  const seriesData = getSeriesData(sharedRows, 'stream');

  expect(getColor(seriesData, 'shipped')).toEqual(
    getColor(seriesData, 'greenfield'),
  );
});

test('an empty color_by control leaves the nodes untouched', () => {
  const withoutControl = getSeriesData(rows);
  getLabelsColorMap().clear();
  const withEmptyControl = getSeriesData(rows, undefined);
  expect(withEmptyControl).toEqual(withoutControl);
});
