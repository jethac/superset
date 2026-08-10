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
import buildQuery from '../../src/Sankey/buildQuery';
import { SankeyFormData } from '../../src/Sankey/types';

const formData: SankeyFormData = {
  colorScheme: 'bnbColors',
  datasource: '5__table',
  viz_type: 'sankey_v2',
  metric: 'count',
  source: 'stage_from',
  target: 'stage_to',
  row_limit: 100,
};

test('groupby holds only source and target when color_by is unset', () => {
  const [query] = buildQuery(formData).queries;
  expect(query.groupby).toEqual(['stage_from', 'stage_to']);
  expect(query.orderby).toEqual([
    ['stage_from', true],
    ['stage_to', true],
  ]);
});

test('groupby includes color_by when set, without affecting orderby', () => {
  const [query] = buildQuery({ ...formData, color_by: 'stream' }).queries;
  expect(query.groupby).toEqual(['stage_from', 'stage_to', 'stream']);
  expect(query.orderby).toEqual([
    ['stage_from', true],
    ['stage_to', true],
  ]);
});

test('sort_by_metric keeps precedence over the column ordering', () => {
  const [query] = buildQuery({
    ...formData,
    color_by: 'stream',
    sort_by_metric: true,
  }).queries;
  expect(query.orderby).toEqual([
    ['count', false],
    ['stage_from', true],
    ['stage_to', true],
  ]);
});
