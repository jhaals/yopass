import React from "react";
import { useAsync } from "react-use";
import { loadConfig } from "./configLoader";
import { ConfigContext } from "./useConfig";

export const ConfigProvider = ({ children }: { children: React.ReactNode }) => {
  const { value: config, loading } = useAsync(loadConfig, []);

  if (loading) {
    return null;
  }

  return (
    <ConfigContext.Provider value={config!}>{children}</ConfigContext.Provider>
  );
};
