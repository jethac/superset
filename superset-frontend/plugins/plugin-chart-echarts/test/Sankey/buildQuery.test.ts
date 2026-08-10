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
  granularity_sqla: 'ds',
  viz_type: 'sankey_v2',
  metric: 'count',
  source: 'stage_from',
  target: 'stage_to',
  row_limit: 100,
  sort_by_metric: true,
};

test('groups by source and target when Color by is unset', () => {
  const [query] = buildQuery(formData).queries;
  expect(query.groupby).toEqual(['stage_from', 'stage_to']);
});

test('groups by the Color by column when it is set', () => {
  const [query] = buildQuery({ ...formData, color_by: 'stream' }).queries;
  expect(query.groupby).toEqual(['stage_from', 'stage_to', 'stream']);
});

test('does not order by the Color by column', () => {
  const [query] = buildQuery({ ...formData, color_by: 'stream' }).queries;
  expect(query.orderby).toEqual([
    ['count', false],
    ['stage_from', true],
    ['stage_to', true],
  ]);
});
