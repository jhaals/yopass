import { Database } from "./database/database";
import { Memcached } from "./database/memcached";

export class Yopass {

    static create() {
        return new Yopass(Memcached.create({}))
    }

    private constructor(private readonly database: Database) {

    }

    async storeSecret(options: {secret: string, ttl: number}): Promise<string> {
        const key = '134'
        await this.database.store({key, secret: options.secret, ttl: options.ttl})
        return key
    }
}