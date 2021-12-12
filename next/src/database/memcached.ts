import { Database, GetResponse, StoreRequest, StoreResponse } from "./database";
import memjs from 'memjs';

type MemcachedOptions = {

}

export class Memcached implements Database {
    private constructor(private readonly client: memjs.Client) {
    }

    static create(options: MemcachedOptions): Memcached {
        const client = memjs.Client.create()
        return new Memcached(client)
    }

    async get(options: { key: string; }): Promise<GetResponse> {
        const result = await this.client.get(options.key)
        return {message: result.value}
    }

    async store(options: StoreRequest): Promise<StoreResponse> {
        await this.client.set(options.key, options.secret, {expires:options.ttl})
        return {}
     }

    async delete(options: { key: string; }): Promise<void> {
        await this.client.delete(options.key)
    }

}