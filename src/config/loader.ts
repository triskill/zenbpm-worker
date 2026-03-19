import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { ConfigSchema, WorkerConfig } from './types';

/**
 * Resolves a credential field value.
 * - If the value starts with "env:", the remainder is treated as an env var name.
 * - Otherwise the raw string value is returned as-is (allows plain literals).
 */
export function resolveFieldValue(raw: string): string {
  if (raw.startsWith('env:')) {
    const varName = raw.slice(4);
    const value = process.env[varName];
    if (value === undefined) {
      throw new Error(
        `[Config] Environment variable "${varName}" is not set (referenced as "env:${varName}")`,
      );
    }
    return value;
  }
  return raw;
}

/**
 * Loads and validates the YAML config file.
 * All credential fields using "env:VAR" syntax are resolved from the environment.
 * Throws with a descriptive message if the file is invalid or env vars are missing.
 */
export function loadConfig(filePath: string): WorkerConfig {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[Config] Config file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(raw);

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`[Config] Invalid configuration:\n${issues}`);
  }

  const config = result.data;

  // Resolve env: references in all credential fields
  for (const [credName, cred] of Object.entries(config.credentials)) {
    for (const [field, raw] of Object.entries(cred.fields)) {
      try {
        cred.fields[field] = resolveFieldValue(raw);
      } catch (err) {
        throw new Error(
          `[Config] credentials.${credName}.fields.${field}: ${(err as Error).message}`,
        );
      }
    }
  }

  // Validate credential references in all worker mappings
  for (const worker of config.workers) {
    if (worker.adapter === 'n8n') {
      // n8n workers reference a map of credential keys → named credentials
      for (const [nodeCredKey, credName] of Object.entries(worker.credentials)) {
        if (!config.credentials[credName]) {
          throw new Error(
            `[Config] Worker "${worker.jobType}" (n8n) references credential "${credName}" ` +
              `(for node key "${nodeCredKey}") which is not defined in the credentials section.`,
          );
        }
      }
    } else if (worker.adapter === 'http') {
      // http workers reference a single optional credential name
      if (worker.credential && !config.credentials[worker.credential]) {
        throw new Error(
          `[Config] Worker "${worker.jobType}" (http) references credential "${worker.credential}" ` +
            `which is not defined in the credentials section.`,
        );
      }
    }
  }

  return config;
}
