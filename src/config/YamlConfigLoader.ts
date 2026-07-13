import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { ConfigFileNotFoundError, ConfigParseError } from "./errors";

export class YamlConfigLoader {
  load(filePath: string): unknown {
    if (!existsSync(filePath)) {
      throw new ConfigFileNotFoundError(filePath);
    }

    const contents = readFileSync(filePath, "utf-8");

    try {
      return parse(contents);
    } catch (cause) {
      throw new ConfigParseError(filePath, cause);
    }
  }
}
