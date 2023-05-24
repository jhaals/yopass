import { Database, GetResponse, StoreRequest, StoreResponse } from './database';
import memjs from 'memjs';

type MemcachedOptions = {};

export class Memcached implements Database {
  private constructor(private readonly client: memjs.Client) {}

  static async create(options: MemcachedOptions): Promise<Memcached> {
    const client = memjs.Client.create();
    return new Memcached(client);
  }

  async get(options: { key: string }): Promise<GetResponse> {
    const result = await this.client.get(options.key);

    if (!result.value) {
      throw Error('Secret not found');
    }
    const data: GetResponse = JSON.parse(result.value.toString('utf-8'));
    return data;
  }

  async store(options: StoreRequest): Promise<StoreResponse> {
    const { ttl, oneTime, key } = options;
    await this.client.set(
      key,
      JSON.stringify({
        message: options.secret,
        ttl,
        oneTime,
      }),
      {
        expires: ttl,
      },
    );
    return {};
  }

  async delete(options: { key: string }): Promise<void> {
    await this.client.delete(options.key);
  }
}
