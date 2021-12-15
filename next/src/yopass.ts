import { Database } from './database/database';
import { Memcached } from './database/memcached';

export class Yopass {
  static create() {
    return new Yopass(Memcached.create({}));
  }

  private constructor(private readonly database: Database) {}

  async storeSecret(options: { secret: string; ttl: number, key: string; }): Promise<string> {
    await this.database.store({
      key: options.key,
      secret: options.secret,
      ttl: options.ttl,
    });
    // TODO: fix/skip return
    return options.key;
  }
}
