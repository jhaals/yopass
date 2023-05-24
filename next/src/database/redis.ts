import { Database, GetResponse, StoreRequest, StoreResponse } from './database';
import { createClient, RedisClientType } from 'redis';

type RedisOptions = {
  url?: string;
};

export class Redis implements Database {
  private constructor(private readonly client: RedisClientType<any, any>) {}

  static async create(options: RedisOptions): Promise<Redis> {
    const client = createClient({ url: options.url });
    await client.connect();
    return new Redis(client);
  }

  async get(options: { key: string }): Promise<GetResponse> {
    const result = await this.client.get(options.key);

    if (!result) {
      throw Error('Secret not found');
    }
    const data: GetResponse = JSON.parse(result);
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
      { EX: ttl },
    );
    return { key };
  }

  async delete(options: { key: string }): Promise<void> {
    await this.client.del(options.key);
  }
}
