/**
 * Validation of model-supplied tool arguments against a tool's JSON Schema.
 *
 * Covers the schema subset the catalog's definitions use: `type` (including
 * type lists), `enum`, `minimum`/`maximum`, `minLength`, `minItems`/`maxItems`,
 * `items`, `required`, and `additionalProperties: false`. A keyword outside
 * that subset is ignored, so a new schema must stay within it to be enforced.
 */

type SchemaNode = {
    type?: string | string[];
    enum?: readonly unknown[];
    minimum?: number;
    maximum?: number;
    minLength?: number;
    minItems?: number;
    maxItems?: number;
    items?: SchemaNode;
    properties?: Record<string, SchemaNode>;
    required?: readonly string[];
    additionalProperties?: boolean;
};

const matchesType = (value: unknown, type: string): boolean => {
    switch (type) {
        case 'integer':
            return Number.isSafeInteger(value);
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'array':
            return Array.isArray(value);
        case 'object':
            return value !== null && typeof value === 'object' && !Array.isArray(value);
        default:
            return typeof value === type;
    }
};

/**
 * Return a message naming the first violation, or null when `value` conforms.
 * `path` prefixes every message so the model can locate the bad argument.
 */
export function validateArgs(value: unknown, rawSchema: object, path = 'arguments'): string | null {
    const schema = rawSchema as SchemaNode;
    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.some((type) => matchesType(value, type))) {
            return `${path} must be ${types.join(' or ')}.`;
        }
    }
    if (schema.enum && !schema.enum.includes(value)) {
        return `${path} must be one of: ${schema.enum.join(', ')}.`;
    }
    if (
        typeof value === 'number' &&
        (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))
    ) {
        return `${path} must be between ${schema.minimum ?? '-infinity'} and ${schema.maximum ?? 'infinity'}.`;
    }
    if (typeof value === 'string' && schema.minLength && value.trim().length < schema.minLength) {
        return `${path} cannot be empty.`;
    }
    if (Array.isArray(value)) {
        if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) {
            return `${path} must have between ${schema.minItems ?? 0} and ${schema.maxItems ?? 'any number of'} items.`;
        }
        if (schema.items) {
            for (let index = 0; index < value.length; index++) {
                const error = validateArgs(value[index], schema.items, `${path}[${index}]`);
                if (error) return error;
            }
        }
        return null;
    }
    if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const properties = schema.properties ?? {};
        for (const key of schema.required ?? []) {
            if (!(key in record)) return `${path}.${key} is required.`;
        }
        for (const [key, item] of Object.entries(record)) {
            if (!Object.prototype.hasOwnProperty.call(properties, key)) {
                if (schema.additionalProperties === false) {
                    return `Unknown argument ${path}.${key}. Allowed: ${Object.keys(properties).join(', ') || 'none'}.`;
                }
                continue;
            }
            const error = validateArgs(item, properties[key], `${path}.${key}`);
            if (error) return error;
        }
    }
    return null;
}
