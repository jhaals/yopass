import { act, fireEvent, render, waitForElement } from '@testing-library/react';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import App from './App';
import Create from './Create';

it('renders without crashing', () => {
  const div = document.createElement('div');
  ReactDOM.render(<App />, div);
  ReactDOM.unmountComponentAtNode(div);
});

const key = '4341ddd7-4ed9-4dd7-a977-d2de10d80eda';
export const fetchSpy = jest.spyOn(window, 'fetch').mockImplementation(() => {
  const r = new Response();
  r.json = () => Promise.resolve({ message: key });
  return Promise.resolve(r);
});

it('create secrets', async () => {
  const password = 'AAAAAAAAAAAAAAAAAAAAAA';

  await act(async () => {
    const { getByText, getByDisplayValue, getByPlaceholderText } = render(
      <Create />,
    );

    await fireEvent.change(
      getByPlaceholderText('Message to encrypt locally in your browser'),
      {
        target: { value: 'chuck' },
      },
    );
    await fireEvent.click(getByText(/Encrypt Message/));
    getByText('Encrypting message...');

    await waitForElement(() => getByText('Secret stored in database'));

    expect(
      (getByDisplayValue(password) as HTMLInputElement).value,
    ).toBeDefined();
    expect(
      (getByDisplayValue(
        `http://localhost/#/s/${key}/${password}`,
      ) as HTMLInputElement).value,
    ).toBeDefined();
    expect(
      (getByDisplayValue(`http://localhost/#/s/${key}`) as HTMLInputElement)
        .value,
    ).toBeDefined();
  });
});

(global as any).window = Object.create(window);
Object.defineProperty(window, 'crypto', {
  value: {
    getRandomValues: () => new Uint8Array(1),
  },
});
