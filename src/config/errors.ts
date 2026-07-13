export class ConfigFileNotFoundError extends Error {
  constructor(filePath: string) {
    super(
      `Configuration file not found: "${filePath}". Make sure it exists in the config directory.`,
    );
    this.name = "ConfigFileNotFoundError";
  }
}

export class ConfigParseError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(
      `Failed to parse "${filePath}" as valid YAML: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "ConfigParseError";
  }
}

export class ConfigValidationError extends Error {
  constructor(filePath: string, issues: string[]) {
    super(`Invalid configuration in "${filePath}":\n- ${issues.join("\n- ")}`);
    this.name = "ConfigValidationError";
  }
}
