import { fireEvent, render, act } from '@testing-library/react';
import * as React from 'react';
import { MemoryRouter, Route } from 'react-router';
import DisplaySecret from './DisplaySecret';
import { rSpy } from './Download.test';

const password = 'cqVQUCzCuLbNOej6uyAUwb';

rSpy;

it('displays secrets', async () => {
  await act(async () => {
    const { getByText } = render(routesWithPath(`/s/foo/${password}`));

    process.nextTick(() => {
      expect(
        getByText(
          'This secret might not be viewable again, make sure to save it now!',
        ),
      ).toBeTruthy();
      expect(getByText('hello')).toBeTruthy();
    });
  });
});

it('displays form if password is missing', async () => {
  await act(async () => {
    const { getByText, getByPlaceholderText } = render(
      routesWithPath('/s/foo/'),
    );
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
});

it('displays error with incorrect password', async () => {
  await act(async () => {
    const { getByText } = render(routesWithPath(`/s/foo/incorrect`));

    process.nextTick(() => {
      expect(getByText('Secret does not exist')).toBeTruthy();
    });
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
