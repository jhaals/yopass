export type GetResponse = {
  message: string;
  ttl: number;
  oneTime: boolean;
};

export type StoreResponse = {};

export type StoreRequest = {
  key: string;
  secret: string;
  ttl: number;
  oneTime: boolean;
};

export interface Database {
  get(options: { key: string }): Promise<GetResponse>;
  store(options: StoreRequest): Promise<StoreResponse>;
  delete(options: { key: string }): Promise<void>;
}
