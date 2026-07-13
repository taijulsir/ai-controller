import path from "node:path";

export const CONFIG_DIRECTORY = path.resolve(__dirname, "../../config");

export const ConfigFileName = {
  Controller: "controller.yaml",
  Claude: "claude.yaml",
  Github: "github.yaml",
  Telegram: "telegram.yaml",
  Repositories: "repositories.yaml",
} as const;

export type ConfigFileName = (typeof ConfigFileName)[keyof typeof ConfigFileName];
