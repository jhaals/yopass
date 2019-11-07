import { fireEvent, render, waitForElement } from '@testing-library/react';
import * as React from 'react';
import Upload from './Upload';

(global as any).window = Object.create(window);
Object.defineProperty(window, 'crypto', {
  value: {
    getRandomValues: () => new Uint8Array(1),
  },
});

it('downloads files', async () => {
  const key = '4341ddd7-4ed9-4dd7-a977-d2de10d80eda';
  jest.spyOn(window, 'fetch').mockImplementationOnce(() => {
    const r = new Response();
    r.json = () => Promise.resolve({ message: key });
    return Promise.resolve(r);
  });

  const { getByText, getByDisplayValue } = render(<Upload />);
  const drop = getByText('Drop file to upload');
  const file = new File(['hello'], 'hello.txt');
  Object.defineProperty(drop, 'files', { value: [file] });
  fireEvent.drop(drop);
  await waitForElement(() => getByText('Secret stored in database'));
  expect(
    (getByDisplayValue(
      `http://localhost/#/f/${key}/AAAAAAAAAAAAAAAAAAAAAA`,
    ) as HTMLInputElement).value,
  ).toBeDefined();
});
