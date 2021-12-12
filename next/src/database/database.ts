export type GetResponse = {
    message: string | Buffer
}

export type StoreResponse = {
}

export type StoreRequest = {
    key: string,
    secret: string | Buffer,
    ttl: number
}

export interface Database {
    get(options: { key: string}): Promise<GetResponse>
    store(options: StoreRequest): Promise<StoreResponse>
    delete(options: {key: string}): Promise<void>
}