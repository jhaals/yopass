import React, { createContext, useContext, useEffect, useState } from "react";

interface Config {
  DISABLE_UPLOAD: boolean;
}

const ConfigContext = createContext<Config | undefined>(undefined);

export const ConfigProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [config, setConfig] = useState<Config>({ DISABLE_UPLOAD: false });

  useEffect(() => {
    fetch("/config")
      .then((response) => response.json())
      .then((data) => setConfig({ DISABLE_UPLOAD: data.DISABLE_UPLOAD === "true" }))
      .catch((error) => console.error("Error loading config:", error));
  }, []);

  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
};

export const useConfig = () => {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error("useConfig must be used within a ConfigProvider");
  }
  return context;
};
