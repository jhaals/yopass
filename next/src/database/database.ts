export type GetResponse = {
  message: string;
  ttl: number;
};

export type StoreResponse = {};

export type StoreRequest = {
  key: string;
  secret: string;
  ttl: number;
};

export interface Database {
  get(options: { key: string }): Promise<GetResponse>;
  store(options: StoreRequest): Promise<StoreResponse>;
  delete(options: { key: string }): Promise<void>;
}
