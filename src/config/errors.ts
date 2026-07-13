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

export class MissingEnvironmentVariableError extends Error {
  constructor(filePath: string, variableName: string) {
    super(
      `Configuration file "${filePath}" references environment variable "\${${variableName}}", but it is not set. Define it in your environment or in a .env file at the project root.`,
    );
    this.name = "MissingEnvironmentVariableError";
  }
}
