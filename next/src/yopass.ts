import { Database } from './database/database';
import { v4 as uuidv4 } from 'uuid';

export class Yopass {
  static async create() {
    if (process.env.DATABASE_TYPE === 'redis') {
      const { Redis } = await import('./database/redis');
      return new Yopass(await Redis.create({ url: process.env.REDIS_URL }));
    }
    const { Memcached } = await import('./database/memcached');
    return new Yopass(await Memcached.create({}));
  }

  private constructor(private readonly database: Database) {}

  async storeSecret(options: {
    secret: string;
    ttl: number;
    oneTime: boolean;
  }): Promise<{ key: string }> {
    const key = uuidv4();
    await this.database.store({
      key,
      ...options,
    });
    return { key };
  }

  async storeFile(options: {
    secret: string;
    ttl: number;
    oneTime: boolean;
  }): Promise<{ key: string }> {
    const key = uuidv4();
    await this.database.store({
      key,
      ...options,
    });
    return { key };
  }

  async getSecret(options: { key: string }): Promise<{
    message: string;
    ttl: number;
    oneTime: boolean;
  }> {
    const { key } = options;
    const result = await this.database.get({
      key,
    });

    if (result.oneTime) {
      await this.database.delete({ key });
    }
    return result;
  }

  async getFile(options: { key: string }): Promise<{
    message: string;
    ttl: number;
    oneTime: boolean;
  }> {
    const { key } = options;
    const result = await this.database.get({
      key,
    });

    if (result.oneTime) {
      await this.database.delete({ key });
    }
    return result;
  }
}
