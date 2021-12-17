import { Database } from './database/database';
import { Memcached } from './database/memcached';

export class Yopass {
  static create() {
    return new Yopass(Memcached.create({}));
  }

  private constructor(private readonly database: Database) {}

  async storeSecret(options: {
    secret: string;
    ttl: number;
    key: string;
    oneTime: boolean;
  }): Promise<string> {
    await this.database.store({
      ...options,
    });
    // TODO: fix/skip return
    return options.key;
  }

  async getSecret(options: {
    key: string;
  }): Promise<{ message: string; ttl: number; oneTime: boolean }> {
    const result = await this.database.get({
      key: options.key,
    });

    return result;
  }
}
