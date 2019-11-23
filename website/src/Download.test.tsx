import { act, render } from '@testing-library/react';
import * as FileSaver from 'file-saver';
import * as React from 'react';
import { MemoryRouter, Route } from 'react-router';
import Download from './Download';

const secret =
  '-----BEGIN PGP MESSAGE-----\r\nVersion: OpenPGP.js v4.6.2\r\nComment: https://openpgpjs.org\r\n\r\nwy4ECQMIHH/PgtGfrkjgsBmMV1f9IfuYqueicr2hQV8nPEKClDDYnY8U/Ogq\r\nKgt40j0BIXuy9eI4wVJURXm70cLJ8Ci4+R85D+1YC6sMr8xGm25SzR1/1vAH\r\nX4AE3ARlV5piJwmtlkOb897RngNP\r\n=Blq3\r\n-----END PGP MESSAGE-----\r\n';
const password = 'cqVQUCzCuLbNOej6uyAUwb';

export const rSpy = jest.spyOn(window, 'fetch').mockImplementation(() => {
  const r = new Response();
  r.json = () => Promise.resolve({ message: secret });
  return Promise.resolve(r);
});

it('downloads files', async () => {
  await act(async () => {
    spyOn(FileSaver, 'saveAs').and.stub();
    const { getByText } = render(routesWithPath(`/f/foo/${password}`));
    expect(
      getByText(
        'Make sure to download the file since it is only available once',
      ),
    ).toBeTruthy();
  });
});

it('asks for password for download', async () => {
  await act(async () => {
    const { getByText } = render(routesWithPath(`/f/foo`));
    expect(
      getByText('A decryption key is required, please enter it below'),
    ).toBeTruthy();
  });
});

const routesWithPath = (path: string) => (
  <MemoryRouter initialEntries={[path]}>
    <Route path="/f/:key/:password">
      <Download />
    </Route>
    <Route path="/f/:key/">
      <Download />
    </Route>
    ,
  </MemoryRouter>
);
