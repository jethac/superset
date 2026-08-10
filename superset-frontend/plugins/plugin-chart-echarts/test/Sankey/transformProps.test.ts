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
import type { SankeySeriesOption } from 'echarts/charts';
import {
  CategoricalColorNamespace,
  ChartProps,
  QueryFormData,
} from '@superset-ui/core';
import { supersetTheme } from '@apache-superset/core/theme';
import transformProps from '../../src/Sankey/transformProps';
import { SankeyChartProps } from '../../src/Sankey/types';

const SLICE_ID = 42;

const formData: QueryFormData = {
  colorScheme: 'bnbColors',
  datasource: '5__table',
  granularity_sqla: 'ds',
  viz_type: 'sankey_v2',
  metric: 'count',
  source: 'stage_from',
  target: 'stage_to',
  slice_id: SLICE_ID,
};

/**
 * Two streams flowing through namespaced stages, plus a stage node ('review')
 * shared by both streams.
 */
const data = [
  {
    stage_from: 'bugfix ▸ triaged',
    stage_to: 'review',
    stream: 'bugfix',
    count: 3,
  },
  {
    stage_from: 'greenfield ▸ triaged',
    stage_to: 'review',
    stream: 'greenfield',
    count: 5,
  },
  {
    stage_from: 'bugfix ▸ triaged',
    stage_to: 'bugfix ▸ merged',
    stream: 'bugfix',
    count: 2,
  },
];

const queriesData = [
  {
    colnames: ['stage_from', 'stage_to', 'stream', 'count'],
    data,
  },
];

const colorFn = CategoricalColorNamespace.getScale('bnbColors');

const getNodeColors = (
  overrides: Partial<QueryFormData> = {},
): Record<string, string | undefined> => {
  const chartProps = new ChartProps({
    formData: { ...formData, ...overrides },
    width: 800,
    height: 600,
    queriesData,
    theme: supersetTheme,
  });
  const { echartOptions } = transformProps(chartProps as SankeyChartProps);
  const { series } = echartOptions as { series: SankeySeriesOption };
  const nodes = (series.data ?? []) as {
    name: string;
    itemStyle: { color: string };
  }[];
  return Object.fromEntries(
    nodes.map(node => [node.name, node.itemStyle.color]),
  );
};

test('colors nodes by their name when Color by is unset', () => {
  expect(getNodeColors()).toEqual({
    'bugfix ▸ triaged': colorFn('bugfix ▸ triaged', SLICE_ID),
    review: colorFn('review', SLICE_ID),
    'greenfield ▸ triaged': colorFn('greenfield ▸ triaged', SLICE_ID),
    'bugfix ▸ merged': colorFn('bugfix ▸ merged', SLICE_ID),
  });
});

test('leaves the rest of the ECharts option untouched when Color by is set', () => {
  const optionWithout = new ChartProps({
    formData,
    width: 800,
    height: 600,
    queriesData,
    theme: supersetTheme,
  });
  const optionWith = new ChartProps({
    formData: { ...formData, color_by: 'stream' },
    width: 800,
    height: 600,
    queriesData,
    theme: supersetTheme,
  });
  const seriesOf = (chartProps: ChartProps) =>
    (
      transformProps(chartProps as SankeyChartProps).echartOptions as {
        series: SankeySeriesOption;
      }
    ).series;
  const without = seriesOf(optionWithout);
  const withColorBy = seriesOf(optionWith);
  expect(withColorBy.links).toEqual(without.links);
  expect(withColorBy.lineStyle).toEqual({ color: 'source' });
  expect(
    (withColorBy.data ?? []).map(node => (node as { name: string }).name),
  ).toEqual((without.data ?? []).map(node => (node as { name: string }).name));
});

test('colors nodes of the same stream identically when Color by is set', () => {
  const colors = getNodeColors({ color_by: 'stream' });
  expect(colors['bugfix ▸ triaged']).toBe(colorFn('bugfix', SLICE_ID));
  expect(colors['bugfix ▸ merged']).toBe(colorFn('bugfix', SLICE_ID));
  expect(colors['greenfield ▸ triaged']).toBe(colorFn('greenfield', SLICE_ID));
  expect(colors['bugfix ▸ triaged']).not.toBe(colors['greenfield ▸ triaged']);
});

test('falls back to name coloring for a node shared by several Color by values', () => {
  const colors = getNodeColors({ color_by: 'stream' });
  expect(colors.review).toBe(colorFn('review', SLICE_ID));
  expect(colors.review).not.toBe(colorFn('bugfix', SLICE_ID));
  expect(colors.review).not.toBe(colorFn('greenfield', SLICE_ID));
});
