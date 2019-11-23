export const fetchMock = (payload: any) =>
  jest.spyOn(window, 'fetch').mockImplementation(() => {
    const r = new Response();
    r.json = () => Promise.resolve(payload);
    return Promise.resolve(r);
  });

it('contains helpers', async () => {});

(global as any).window = Object.create(window);
Object.defineProperty(window, 'crypto', {
  value: {
    getRandomValues: () => new Uint8Array(1),
  },
});
