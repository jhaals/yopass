export const useBaseUrl = function (): string {
  return (process.env.PUBLIC_URL ||
      `${window.location.protocol}//${window.location.host}`);
}

export const useAbsoluteDecryptionRouteBase = function (): string {
    const baseUrl = process.env.PUBLIC_DECRYPTION_URL || useBaseUrl();
    return baseUrl + useRelativeRouteBase();
}

export const useAbsoluteRouteBase = function (): string {
    return useBaseUrl() + useRelativeRouteBase();
}

export const useRelativeRouteBase = function (): string {
  return process.env.ROUTER_TYPE === 'hash' ? '/#' : '';
}
