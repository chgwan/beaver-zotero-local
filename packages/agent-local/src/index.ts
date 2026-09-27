/**
 * Public surface of the in-plugin agent. A host imports from this barrel; the
 * package's own modules import each other by relative path.
 */
export { LOCAL_AGENT_PACKAGE_VERSION } from './version';
export {
    resolveLocalAgentConfig,
    DEFAULT_MAX_ROUNDS,
    SUPPORTED_FORMATS,
} from './config/localAgentConfig';
export type {
    LocalAgentConfig,
    LocalAgentConfigInput,
    LocalConfigResult,
    LocalConfigError,
    SupportedFormat,
} from './config/localAgentConfig';
