import { fireEvent, render } from '@testing-library/react';
import * as React from 'react';
import { MemoryRouter, Route } from 'react-router';
import DisplaySecret from './DisplaySecret';

const secret =
  '-----BEGIN PGP MESSAGE-----\r\nVersion: OpenPGP.js v4.6.2\r\nComment: https://openpgpjs.org\r\n\r\nwy4ECQMIHH/PgtGfrkjgsBmMV1f9IfuYqueicr2hQV8nPEKClDDYnY8U/Ogq\r\nKgt40j0BIXuy9eI4wVJURXm70cLJ8Ci4+R85D+1YC6sMr8xGm25SzR1/1vAH\r\nX4AE3ARlV5piJwmtlkOb897RngNP\r\n=Blq3\r\n-----END PGP MESSAGE-----\r\n';
const password = 'cqVQUCzCuLbNOej6uyAUwb';

jest.spyOn(window, 'fetch').mockImplementation(() => {
  const r = new Response();
  r.json = () => Promise.resolve({ message: secret });
  return Promise.resolve(r);
});

it('displays secrets', async () => {
  const { getByText } = render(routesWithPath(`/s/foo/${password}`));

  expect(
    getByText(
      'Fetching from database and decrypting in browser, please hold...',
    ),
  ).toBeTruthy();

  process.nextTick(() => {
    expect(
      getByText(
        'This secret will not be viewable again, make sure to save it now!',
      ),
    ).toBeTruthy();
    expect(getByText('hello')).toBeTruthy();
  });
});

it('displays form if password is missing', async () => {
  const { getByText, getByPlaceholderText } = render(routesWithPath('/s/foo/'));
  expect(
    getByText('A decryption key is required, please enter it below'),
  ).toBeTruthy();

  fireEvent.change(getByPlaceholderText('Decryption Key'), {
    target: { value: password },
  });
  fireEvent.click(getByText(/Decrypt Secret/));

  process.nextTick(() => {
    expect(getByText('hello')).toBeTruthy();
  });
});

it('displays error with incorrect password', async () => {
  const { getByText } = render(routesWithPath(`/s/foo/incorrect`));

  process.nextTick(() => {
    expect(getByText('Secret does not exist')).toBeTruthy();
  });
});

const routesWithPath = (path: string) => (
  <MemoryRouter initialEntries={[path]}>
    <Route path="/s/:key/:password">
      <DisplaySecret />
    </Route>
    <Route path="/s/:key/">
      <DisplaySecret />
    </Route>
    ,
  </MemoryRouter>
);
