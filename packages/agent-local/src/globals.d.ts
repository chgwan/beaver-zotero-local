/*
 * Minimal ambient declarations for the host globals the local agent uses,
 * narrowed to the members actually called. Declaring these instead of adding
 * lib "DOM" keeps the full DOM surface out of the standalone typecheck, so any
 * new host-environment dependency fails loudly here.
 */

/**
 * Connectivity probe. Declared possibly-undefined so call sites must guard
 * with `typeof navigator !== 'undefined'` — not every host provides it.
 */
declare const navigator: { onLine: boolean; platform?: string; userAgent?: string } | undefined;

/** Development logging. Possibly-undefined: some host contexts have no console. */
declare const console: { log(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void } | undefined;

/** Unique-id generation for run, message, and tool-call ids. */
declare const crypto: { randomUUID(): string };

/** Endpoint parsing and validation. */
declare class URL {
    constructor(url: string, base?: string);
    protocol: string;
    hostname: string;
    host: string;
    pathname: string;
    href: string;
}

/** Query-string building for provider requests. */
declare class URLSearchParams {
    constructor(init?: Record<string, string>);
    set(name: string, value: string): void;
    append(name: string, value: string): void;
    toString(): string;
}

declare interface TimerHandle {
    readonly __timerHandle: unique symbol;
}
declare function setTimeout(handler: (...args: any[]) => void, timeoutMs?: number): TimerHandle;
declare function clearTimeout(handle: TimerHandle | null | undefined): void;

declare interface AbortSignal {
    readonly aborted: boolean;
    addEventListener(type: 'abort', listener: () => void): void;
    removeEventListener(type: 'abort', listener: () => void): void;
}
declare class AbortController {
    readonly signal: AbortSignal;
    abort(): void;
}

/**
 * One chunk of a streamed body. `done` and `value` follow the web streams
 * contract: `value` is undefined on the final read.
 */
declare interface StreamReadResult {
    done: boolean;
    value?: Uint8Array;
}

/**
 * The reader half of a streamed response body. `cancel` is what makes an
 * aborted run stop pulling bytes from the provider.
 */
declare interface StreamReader {
    read(): Promise<StreamReadResult>;
    cancel(reason?: string): Promise<void>;
    releaseLock(): void;
}

declare interface ResponseBody {
    getReader(): StreamReader;
}

/** Response headers the provider clients and search sources read (e.g. Retry-After). */
declare interface ResponseHeaders {
    get(name: string): string | null;
}

/** The response members the provider clients read. */
declare interface Response {
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly headers: ResponseHeaders;
    readonly body: ResponseBody | null;
    text(): Promise<string>;
    json(): Promise<any>;
}

declare interface RequestInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}

declare function fetch(url: string, init?: RequestInit): Promise<Response>;

/** Monotonic elapsed time, used to space host requests; unaffected by wall-clock changes mid-run. */
declare const performance: { now(): number };

/**
 * Incremental UTF-8 decoding of streamed bytes. `stream: true` keeps partial
 * multi-byte sequences buffered across chunk boundaries.
 */
declare class TextDecoder {
    constructor(label?: string);
    decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}
