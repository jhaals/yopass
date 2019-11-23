import { fireEvent, render, waitForElement } from '@testing-library/react';
import * as React from 'react';
import Upload from './Upload';
import { fetchSpy } from './App.test';

fetchSpy;

it('downloads files', async () => {
  const { getByText, getByDisplayValue } = render(<Upload />);
  const drop = getByText('Drop file to upload');
  const file = new File(['hello'], 'hello.txt');
  Object.defineProperty(drop, 'files', { value: [file] });
  fireEvent.drop(drop);
  await waitForElement(() => getByText('Secret stored in database'));
  expect(
    (getByDisplayValue(
      `http://localhost/#/f/4341ddd7-4ed9-4dd7-a977-d2de10d80eda/AAAAAAAAAAAAAAAAAAAAAA`,
    ) as HTMLInputElement).value,
  ).toBeDefined();
});
