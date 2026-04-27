import canonicalizeJson from "canonicalize";

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export class CanonicalizationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

export function canonicalize(value: unknown): string {
  const result = canonicalizeJson(normalizeJsonStrings(value));
  if (typeof result !== "string") {
    throw new CanonicalizationError("Unable to canonicalize JSON value");
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function normalizeForCanonical(value: unknown): JsonValue {
  return normalizeJsonStrings(value);
}

export function normalizeJsonStrings(value: unknown): JsonValue {
  return normalizeJsonValue(value, "$", new WeakSet<object>());
}

function normalizeJsonValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
): JsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "string":
      return value.normalize("NFC");
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`${path} is not a finite JSON number`);
      }
      return Object.is(value, -0) ? 0 : value;
    case "boolean":
      return value;
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new CanonicalizationError(`${path} is not a JSON value`);
    case "object":
      break;
    default:
      throw new CanonicalizationError(`${path} is not a JSON value`);
  }

  if (seen.has(value)) {
    throw new CanonicalizationError(`${path} contains a circular reference`);
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const output: JsonArray = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new CanonicalizationError(`${path}[${index}] is a sparse array slot`);
        }
        output.push(normalizeJsonValue(value[index], `${path}[${index}]`, seen));
      }
      return output;
    }

    if (!isPlainJsonObject(value)) {
      throw new CanonicalizationError(`${path} is not a plain JSON object`);
    }

    const output: JsonObject = {};
    for (const symbolKey of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, symbolKey)) {
        throw new CanonicalizationError(`${path} contains a symbol key`);
      }
    }

    for (const key of Object.keys(value)) {
      const normalizedKey = key.normalize("NFC");
      if (Object.prototype.hasOwnProperty.call(output, normalizedKey)) {
        throw new CanonicalizationError(
          `${path} contains duplicate key after NFC normalization: ${normalizedKey}`,
        );
      }
      output[normalizedKey] = normalizeJsonValue(
        (value as Record<string, unknown>)[key],
        `${path}.${normalizedKey}`,
        seen,
      );
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function isPlainJsonObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
