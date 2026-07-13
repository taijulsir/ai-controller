import { MissingEnvironmentVariableError } from "./errors";

const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function resolveEnvPlaceholders(value: unknown, filePath: string): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_PLACEHOLDER, (_match, variableName: string) => {
      const resolved = process.env[variableName];
      if (resolved === undefined) {
        throw new MissingEnvironmentVariableError(filePath, variableName);
      }
      return resolved;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvPlaceholders(item, filePath));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveEnvPlaceholders(entry, filePath)]),
    );
  }

  return value;
}
