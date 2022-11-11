import { createResponse, createRequest } from 'node-mocks-http';
import secret from './secret';
import { NextApiRequest, NextApiResponse } from 'next/types';

describe('createSecret', () => {
  it('should fail with invalid content type', async () => {
    const res = createResponse<NextApiResponse>();
    const req = createRequest<NextApiRequest>({
      method: 'GET',
    });

    await secret(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ message: 'Invalid content type' });
  });

  it('should fail with when fields are missing', async () => {
    const res = createResponse<NextApiResponse>();
    const req = createRequest<NextApiRequest>({
      method: 'GET',
      headers: {
        'content-type': 'application/json',
      },
      body: { message: 'test', expiration: 3600 },
    });

    await secret(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ message: 'Invalid payload' });
  });

  it('should fail when expiration is invalid', async () => {
    const res = createResponse<NextApiResponse>();
    const req = createRequest<NextApiRequest>({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: { message: 'test', expiration: 1336, one_time: true },
    });

    await secret(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({
      message: 'Invalid expiration specified',
    });
  });

  it('should fail if secret is too long', async () => {
    const res = createResponse<NextApiResponse>();
    const req = createRequest<NextApiRequest>({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: { message: 'x'.repeat(10001), expiration: 3600, one_time: true },
    });

    await secret(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({
      message: 'Exceeded max secret length',
    });
  });

  it('should store secret', async () => {
    const res = createResponse<NextApiResponse>();
    const req = createRequest<NextApiRequest>({
      method: 'GET',
      headers: {
        'content-type': 'application/json',
      },
      body: { message: 'test', expiration: 3600, one_time: true },
    });

    await secret(req, res);
    expect(res._getStatusCode()).toBe(200);
    // expect(res._getJSONData()).toEqual({
    //   message: 'UUID generated',
    // });
  });
});
