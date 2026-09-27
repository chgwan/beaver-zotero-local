/**
 * Server-sent-events parsing over a streamed response body.
 *
 * A chunk boundary can fall anywhere — inside a JSON value, inside a UTF-8
 * sequence, between the `data:` prefix and its payload — so bytes are decoded
 * incrementally and split on blank lines rather than per chunk. The generator
 * stops promptly when the run is cancelled and always releases the reader.
 */

export interface SseEvent {
    /** The `event:` field, or null when the provider sends only `data:`. */
    event: string | null;
    data: string;
}

const parseBlock = (block: string): SseEvent | null => {
    let event: string | null = null;
    const dataLines: string[] = [];

    for (const rawLine of block.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line.length === 0 || line.startsWith(':')) continue;

        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        // A single leading space after the colon is part of the framing.
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);

        if (field === 'event') event = value;
        else if (field === 'data') dataLines.push(value);
    }

    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join('\n') };
};

/**
 * A streamed response body. Named through `Response` so the reader typechecks
 * both against this package's narrow host declarations and against the DOM
 * library of a host program that imports it.
 */
type StreamedBody = NonNullable<Response['body']>;

export async function* readSseEvents(
    body: StreamedBody,
    signal: AbortSignal
): AsyncGenerator<SseEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
        while (true) {
            if (signal.aborted) return;

            const { done, value } = await reader.read();
            if (done) break;
            if (value) buffer += decoder.decode(value, { stream: true });

            // A blank line terminates an event; \r\n\r\n is the CRLF form.
            let boundary = buffer.search(/\r?\n\r?\n/);
            while (boundary !== -1) {
                const block = buffer.slice(0, boundary);
                const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/);
                buffer = buffer.slice(boundary + (separator ? separator[0].length : 2));

                const parsed = parseBlock(block);
                if (parsed) yield parsed;
                if (signal.aborted) return;

                boundary = buffer.search(/\r?\n\r?\n/);
            }
        }

        // A provider that ends without a final blank line still sent an event.
        const tail = parseBlock(buffer);
        if (tail) yield tail;
    } finally {
        try {
            await reader.cancel();
        } catch {
            // Already closed or errored; nothing to release.
        }
        reader.releaseLock();
    }
}
