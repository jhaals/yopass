import { Database } from './database/database';
import { Memcached } from './database/memcached';
import { v4 as uuidv4 } from 'uuid';

export class Yopass {
  static create() {
    return new Yopass(Memcached.create({}));
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
