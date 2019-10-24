import { fireEvent, render } from '@testing-library/react';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import App from './App';
import Create from './Create';

it('renders without crashing', () => {
  const div = document.createElement('div');
  ReactDOM.render(<App />, div);
  ReactDOM.unmountComponentAtNode(div);
});

it('create secrets', async () => {
  const key = '4341ddd7-4ed9-4dd7-a977-d2de10d80eda';
  const password = 'AAAAAAAAAAAAAAAAAAAAAA';
  jest.spyOn(window, 'fetch').mockImplementationOnce(() => {
    const r = new Response();
    r.json = () => Promise.resolve({ message: key });
    return Promise.resolve(r);
  });

  const { getByText, getByDisplayValue, getByPlaceholderText } = render(
    <Create />,
  );

  fireEvent.change(
    getByPlaceholderText('Message to encrypt locally in your browser'),
    {
      target: { value: 'chuck' },
    },
  );

  fireEvent.click(getByText(/Encrypt Message/));
  process.nextTick(() => {
    expect(getByText('Secret stored in database')).toBeTruthy();
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
