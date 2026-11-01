import { createContext, useContext } from "react";
import type { AppConfig } from "./validate";

const Ctx = createContext<AppConfig | null>(null);
export const ConfigProvider = Ctx.Provider;

export function useConfig(): AppConfig {
  const c = useContext(Ctx);
  if (!c) throw new Error("useConfig outside ConfigProvider");
  return c;
}
