export const useBaseUrl = function (): string {
  return (process.env.PUBLIC_URL ||
      `${window.location.protocol}//${window.location.host}`);
}

export const useAbsoluteRouteBase = function (): string {
    return useBaseUrl() + useRelativeRouteBase();
}

export const useRelativeRouteBase = function (): string {
  return process.env.ROUTER_TYPE === 'hash' ? '/#' : '';
}
