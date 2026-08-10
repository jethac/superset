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
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@superset-ui/core/spec';
import { CellProps, Column } from 'react-table';
import DataTable from '../../src/DataTable/DataTable';
import { ProviderWrapper } from '../testHelpers';

type DataRow = {
  city: string;
};

const data: DataRow[] = [{ city: 'Paris' }, { city: 'London' }];

const columns: Column<DataRow>[] = [
  {
    id: 'city',
    Header: () => <th data-column-name="city">City</th>,
    Cell: ({ value }: CellProps<DataRow>) => <td>{value}</td>,
    accessor: 'city',
  },
];

const renderDataTable = (
  props: {
    columns: Column<DataRow>[];
    onFilteredRowsChange?: (rows: DataRow[]) => void;
  } = { columns },
) => (
  <ProviderWrapper>
    <DataTable<DataRow>
      columns={props.columns}
      data={data}
      rowCount={data.length}
      serverPagination={false}
      serverPaginationData={{}}
      onServerPaginationChange={jest.fn()}
      handleSortByChange={jest.fn()}
      sortByFromParent={[]}
      onSearchColChange={jest.fn()}
      searchOptions={[]}
      onFilteredRowsChange={props.onFilteredRowsChange}
      sticky={false}
    />
  </ProviderWrapper>
);

test('renders rows after a first render with no columns', async () => {
  const { rerender } = render(renderDataTable({ columns: [] }));

  expect(screen.getByText('No data found')).toBeInTheDocument();

  rerender(renderDataTable({ columns }));

  await waitFor(() => {
    expect(screen.getByText('Paris')).toBeInTheDocument();
    expect(screen.getByText('London')).toBeInTheDocument();
  });
});

test('emits filtered rows after the columns arrive', async () => {
  const onFilteredRowsChange = jest.fn();
  const { rerender } = render(
    renderDataTable({ columns: [], onFilteredRowsChange }),
  );

  rerender(renderDataTable({ columns, onFilteredRowsChange }));

  await waitFor(() => {
    expect(onFilteredRowsChange).toHaveBeenCalledWith(data);
  });
});

test('renders the no-results message when the columns go away', async () => {
  const { rerender } = render(renderDataTable({ columns }));

  await waitFor(() => {
    expect(screen.getByText('Paris')).toBeInTheDocument();
  });

  rerender(renderDataTable({ columns: [] }));

  expect(screen.getByText('No data found')).toBeInTheDocument();
});
