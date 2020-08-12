/** @jest-environment jsdom-sixteen */ // Use jsdom-sixteen because of of issues relating to waitFor*

import { fireEvent, render, waitFor } from '@testing-library/react';
import * as React from 'react';
import Create from './Create';

it('password field is not shown by default', async () => {
  const { queryAllByPlaceholderText } = render(<Create />);

  expect(
    queryAllByPlaceholderText('Manually enter decryption key')
  ).toHaveLength(0)
});

it('password field can be toggled', async () => {
  const { getByLabelText, queryAllByPlaceholderText } = render(<Create />);

  expect(
    queryAllByPlaceholderText('Manually enter decryption key')
  ).toHaveLength(0)

  const checkbox = getByLabelText('Generate decryption key');
  expect(
    checkbox
  ).toBeDefined();
  fireEvent.change(checkbox);

  await waitFor(() => expect(queryAllByPlaceholderText('Manually enter decryption key')).toHaveLength(0))
});
