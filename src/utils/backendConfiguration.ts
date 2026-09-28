/**
 * Build-time backend settings.
 *
 * The build substitutes the Beaver server settings from `.env.<mode>`. A build
 * made without them has no Beaver backend to reach, so it can only run in
 * local mode.
 */

export interface BackendConfiguration {
    apiBaseUrl: string;
    supabaseUrl: string;
    supabaseAnonKey: string;
}

/** The Beaver server settings this build was made with (empty when absent). */
export function buildBackendConfiguration(): BackendConfiguration {
    return {
        apiBaseUrl: process.env.API_BASE_URL ?? "",
        supabaseUrl: process.env.SUPABASE_URL ?? "",
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? "",
    };
}

/** Whether every Beaver server setting is present. */
export function hasBackendConfiguration(
    values: BackendConfiguration = buildBackendConfiguration(),
): boolean {
    return Boolean(values.apiBaseUrl && values.supabaseUrl && values.supabaseAnonKey);
}

/**
 * The local-mode state for this plugin load. A build without server settings
 * is always local, whatever the preference says; otherwise the preference decides.
 */
export function resolveLocalMode(
    preference: unknown,
    backendConfigured: boolean,
): { localMode: boolean; forced: boolean } {
    const forced = !backendConfigured;
    return { localMode: forced || preference === true, forced };
}
