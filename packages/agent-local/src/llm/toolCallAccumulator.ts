/**
 * Reassembly of streamed tool calls.
 *
 * Providers stream a tool call's arguments as fragments of JSON text that carry
 * no meaning individually — OpenAI as `function.arguments` deltas keyed by an
 * index, Anthropic as `input_json_delta.partial_json` within a content block.
 * Parsing a fragment yields nothing, and parsing the concatenation early yields
 * nothing while it is still incomplete. So text is accumulated verbatim per
 * call and parsed exactly once, at close.
 *
 * A parse failure is reported, never swallowed: the raw text and the error
 * travel with the call so the loop can tell the model what was wrong instead of
 * invoking a tool with no arguments.
 */

export interface AccumulatedToolCall {
    id: string;
    name: string;
    /** Parsed arguments, or `{}` when nothing arrived or parsing failed. */
    args: Record<string, unknown>;
    /** Everything the provider sent, for diagnostics and retry copy. */
    rawArgs: string;
    parseError: string | null;
}

interface PendingCall {
    id: string;
    name: string;
    argsText: string;
}

export class ToolCallAccumulator {
    /** Insertion-ordered, so parallel calls keep the order the provider sent. */
    private readonly pending = new Map<string, PendingCall>();

    private slot(key: number | string): PendingCall {
        const mapKey = String(key);
        let existing = this.pending.get(mapKey);
        if (!existing) {
            existing = { id: '', name: '', argsText: '' };
            this.pending.set(mapKey, existing);
        }
        return existing;
    }

    /** Begin a call. Safe to call again for the same key: seeds only fill blanks. */
    open(key: number | string, seed: { id?: string; name?: string }): void {
        const slot = this.slot(key);
        if (seed.id) slot.id = seed.id;
        if (seed.name) slot.name = seed.name;
    }

    appendId(key: number | string, id: string): void {
        if (id) this.slot(key).id = id;
    }

    /** Append to the name; some providers deliver it in pieces. */
    appendName(key: number | string, name: string): void {
        if (name) this.slot(key).name += name;
    }

    appendArguments(key: number | string, fragment: string): void {
        if (fragment) this.slot(key).argsText += fragment;
    }

    isEmpty(): boolean {
        return this.pending.size === 0;
    }

    /** Parse every accumulated call. Call once, after the stream ends. */
    close(): AccumulatedToolCall[] {
        const calls: AccumulatedToolCall[] = [];

        for (const [mapKey, slot] of this.pending) {
            const rawArgs = slot.argsText;
            const id = slot.id || `local_call_${mapKey}_${crypto.randomUUID()}`;
            let args: Record<string, unknown> = {};
            let parseError: string | null = null;

            const trimmed = rawArgs.trim();
            if (trimmed.length > 0) {
                try {
                    const parsed = JSON.parse(trimmed);
                    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                        parseError = `Tool arguments must be a JSON object, received ${
                            Array.isArray(parsed) ? 'an array' : typeof parsed
                        }.`;
                    } else {
                        args = parsed as Record<string, unknown>;
                    }
                } catch (error) {
                    parseError = `Tool arguments were not valid JSON: ${
                        error instanceof Error ? error.message : String(error)
                    }`;
                }
            }

            calls.push({ id, name: slot.name, args, rawArgs, parseError });
        }

        return calls;
    }
}

/**
 * The arguments text to send back to the provider when replaying a call.
 *
 * What the provider streamed is sent back verbatim when it was a JSON object,
 * so a request the model can already see is never reworded. Anything else —
 * malformed JSON, a non-object, nothing at all — is replaced by the parsed
 * arguments (`{}` for a failed parse): strict servers reject a transcript
 * whose tool-call arguments are not valid JSON, and the call's failed tool
 * return already tells the model what went wrong.
 */
export function wireArguments(call: AccumulatedToolCall): string {
    if (!call.parseError && call.rawArgs.trim().length > 0) {
        try {
            const parsed: unknown = JSON.parse(call.rawArgs);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return call.rawArgs;
        } catch {
            // Fall through to the parsed arguments.
        }
    }
    return JSON.stringify(call.args ?? {});
}
