import React, { useState, useCallback } from "react";
import Button from "@beaver/agent-ui/primitives/Button";
import {SettingsGroup, SettingsRow, SectionLabel, DocLink, ExternalLink, SectionDescription, INTELLIGENCE_INDEX_URL} from "./components/SettingsElements";
import ApiKeyInput from "./ApiKeyInput";
import CustomProviderCard from "./CustomProviderCard";
import PlusSignIcon from "@beaver/agent-ui/icons/PlusSignIcon";
import { Icon, AlertIcon } from "../icons/icons";
import { getPref, setPref } from "../../../src/utils/prefs";
import { handlePrefSave } from "./utils";
import { activePreferencePageTabAtom, requestPlusToolsAtom } from "../../atoms/ui";
import { remainingBeaverCreditsAtom } from "../../atoms/profile";
import { refreshCustomModelsAtom } from "../../atoms/models";
import { localModeEnabledAtom } from "../../atoms/localMode";
import { localModeStatusAtom, localWebSearchStatusAtom } from "../../atoms/localAgentConfig";
import { usePreference } from "../../hooks/usePreference";
import {
    DEFAULT_LOCAL_WEB_SEARCH_MAX_USES,
    LOCAL_ROUND_CAP_DESCRIPTION,
    LOCAL_WEB_SEARCH_MAX_USES_DESCRIPTION,
    localWebSearchDescription,
    needsLocalModeRestart,
    parseLocalMaxRoundsInput,
    parseLocalWebSearchMaxUsesInput,
    showLocalRoundCap,
} from "./localModeSettings";
import { DEFAULT_MAX_ROUNDS } from "@beaver/agent-local/config/localAgentConfig";
import {
    CustomChatModel,
    getCustomChatModelsForEditing,
    saveCustomChatModelsToPreferences,
    OPENROUTER_API_BASE,
} from "../../types/settings";
import { useAtom, useAtomValue, useSetAtom } from "jotai";

/** Editor entry: a custom model plus a stable key for React list rendering. */
interface CustomProviderEntry {
    _id: string;
    model: CustomChatModel;
}

const createProviderId = (): string => crypto.randomUUID();

// New providers default to OpenRouter's endpoint, the most common custom setup.
const emptyCustomModel = (): CustomChatModel => ({
    name: '',
    snapshot: '',
    api_base: OPENROUTER_API_BASE,
    format: 'openai',
    api_key: '',
    supports_vision: false,
});

const ApiKeysSection: React.FC = () => {
    const setActiveTab = useSetAtom(activePreferencePageTabAtom);
    const refreshCustomModels = useSetAtom(refreshCustomModelsAtom);

    // --- Local Mode ---
    // `localModeActive` reflects the running process (fixed at startup); the
    // `localMode` pref can be flipped live, so the two can disagree until a
    // restart applies the new value.
    const localModeActive = useAtomValue(localModeEnabledAtom);
    const localStatus = useAtomValue(localModeStatusAtom);
    const [localModePref, setLocalModePref] = usePreference(() => getPref('localMode'));
    const [maxRoundsText, setMaxRoundsText] = useState<string>(() => {
        const stored = getPref('localMaxRounds');
        return stored > 0 ? String(stored) : '';
    });
    const restartNeeded = needsLocalModeRestart(localModePref, localModeActive);

    const handleLocalModeToggle = useCallback((checked: boolean) => {
        setPref('localMode', checked);
        setLocalModePref(checked);
    }, [setLocalModePref]);

    const handleMaxRoundsChange = useCallback((text: string) => {
        setMaxRoundsText(text);
        const parsed = parseLocalMaxRoundsInput(text);
        if (parsed !== null) {
            setPref('localMaxRounds', parsed);
        }
    }, []);

    // --- Local Mode: Search ---
    // Read at the start of every local run, so these apply without a restart
    // (unlike `localMode`/`localMaxRounds` above).
    const [scholarlySearchPref, setScholarlySearchPref] = usePreference(() => getPref('localScholarlySearch'));
    const [openAlexKey, setOpenAlexKey] = useState(() => getPref('openAlexApiKey'));
    const [semanticScholarKey, setSemanticScholarKey] = useState(() => getPref('semanticScholarApiKey'));
    const [webSearchPref, setWebSearchPref] = usePreference(() => getPref('localWebSearch'));
    const [maxUsesText, setMaxUsesText] = useState<string>(() => {
        const stored = getPref('localWebSearchMaxUses');
        return stored > 0 ? String(stored) : '';
    });
    const localWebSearchStatus = useAtomValue(localWebSearchStatusAtom);

    const handleScholarlySearchToggle = useCallback((checked: boolean) => {
        setPref('localScholarlySearch', checked);
        setScholarlySearchPref(checked);
    }, [setScholarlySearchPref]);

    const handleWebSearchToggle = useCallback((checked: boolean) => {
        setPref('localWebSearch', checked);
        setWebSearchPref(checked);
    }, [setWebSearchPref]);

    const handleMaxUsesChange = useCallback((text: string) => {
        setMaxUsesText(text);
        const parsed = parseLocalWebSearchMaxUsesInput(text);
        if (parsed !== null) {
            setPref('localWebSearchMaxUses', parsed);
        }
    }, []);

    // --- Atoms: API Keys ---
    const [geminiKey, setGeminiKey] = useState(() => getPref('googleGenerativeAiApiKey'));
    const [openaiKey, setOpenaiKey] = useState(() => getPref('openAiApiKey'));
    const [anthropicKey, setAnthropicKey] = useState(() => getPref('anthropicApiKey'));

    // --- Atoms: Request Plus Tools ---
    const [requestPlusTools, setRequestPlusTools] = useAtom(requestPlusToolsAtom);
    const remainingBeaverCredits = useAtomValue(remainingBeaverCreditsAtom);

    // --- State: Custom Providers ---
    const [customProviders, setCustomProviders] = useState<CustomProviderEntry[]>(() =>
        getCustomChatModelsForEditing().map((model) => ({ _id: createProviderId(), model }))
    );
    // Only one provider card is expanded at a time.
    const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
    // The newly added provider whose Name field should receive focus on mount.
    const [autoFocusProviderId, setAutoFocusProviderId] = useState<string | null>(null);

    // Persist the providers list to preferences and refresh the live model selector.
    const persistProviders = useCallback((entries: CustomProviderEntry[]) => {
        saveCustomChatModelsToPreferences(entries.map((e) => e.model));
        refreshCustomModels();
    }, [refreshCustomModels]);

    const handleAddProvider = useCallback(() => {
        const id = createProviderId();
        // Add new providers to the top of the list so they're immediately visible.
        setCustomProviders((prev) => {
            const next = [{ _id: id, model: emptyCustomModel() }, ...prev];
            persistProviders(next);
            return next;
        });
        setExpandedProviderId(id);
        setAutoFocusProviderId(id);
    }, [persistProviders]);

    const handleProviderChange = useCallback((id: string, model: CustomChatModel) => {
        setCustomProviders((prev) => {
            const next = prev.map((e) => (e._id === id ? { ...e, model } : e));
            persistProviders(next);
            return next;
        });
    }, [persistProviders]);

    const handleRemoveProvider = useCallback((id: string) => {
        setCustomProviders((prev) => {
            const next = prev.filter((e) => e._id !== id);
            persistProviders(next);
            return next;
        });
        setExpandedProviderId((current) => (current === id ? null : current));
    }, [persistProviders]);

    // Insert a copy named "{name} (copy)" directly below the source and expand it.
    const handleDuplicateProvider = useCallback((id: string) => {
        const copyId = createProviderId();
        setCustomProviders((prev) => {
            const index = prev.findIndex((e) => e._id === id);
            if (index === -1) return prev;
            const source = prev[index].model;
            const copy: CustomChatModel = {
                ...source,
                name: `${source.name?.trim() || 'Untitled provider'} (copy)`,
            };
            const next = [...prev];
            next.splice(index + 1, 0, { _id: copyId, model: copy });
            persistProviders(next);
            return next;
        });
        setExpandedProviderId(copyId);
    }, [persistProviders]);

    const handleToggleExpand = useCallback((id: string) => {
        setExpandedProviderId((current) => (current === id ? null : id));
    }, []);

    // --- Handlers: Toggle Request Plus Tools ---
    const handleRequestPlusToolsToggle = useCallback(() => {
        const newValue = !requestPlusTools;
        setPref('requestPlusTools', newValue);
        setRequestPlusTools(newValue);
    }, [requestPlusTools]);

    return (
        <>
            {/* Local Mode */}
            <SectionLabel>Local Mode</SectionLabel>
            <SettingsGroup className="bg-senary">
                <SettingsRow
                    title="Run entirely on this device"
                    description={
                        restartNeeded
                            ? "Connect a custom provider directly, without a Beaver account. Restart Zotero to apply this change."
                            : "Connect a custom provider directly, without a Beaver account."
                    }
                    announceDescription={restartNeeded}
                    control={
                        <input
                            type="checkbox"
                            aria-label="Run entirely on this device"
                            checked={localModePref}
                            onChange={(e) => handleLocalModeToggle(e.target.checked)}
                            onClick={(e) => e.stopPropagation()}
                        />
                    }
                />
                {showLocalRoundCap(localModePref, localModeActive) && (
                    <SettingsRow
                        hasBorder
                        title="Round cap"
                        description={LOCAL_ROUND_CAP_DESCRIPTION}
                        control={
                            <input
                                type="text"
                                inputMode="numeric"
                                value={maxRoundsText}
                                onChange={(e) => handleMaxRoundsChange(e.target.value)}
                                placeholder={String(DEFAULT_MAX_ROUNDS)}
                                aria-label="Maximum tool-calling rounds"
                                className="chat-input text-base font-color-primary"
                                style={{ width: '80px', textAlign: 'right' }}
                            />
                        }
                    />
                )}
                {localModeActive && (
                    <SettingsRow
                        hasBorder
                        className="items-start"
                        announceDescription
                        title="Status"
                        description={
                            <span className={localStatus.ok ? 'font-color-green' : 'font-color-error'}>
                                {localStatus.ok
                                    ? `Ready — using “${localStatus.config.model.name}”.`
                                    : localStatus.message}
                            </span>
                        }
                    />
                )}
            </SettingsGroup>

            {/* Search — local-mode only; these prefs do nothing in cloud mode. */}
            {localModeActive && (
                <>
                    <SectionLabel>Search</SectionLabel>
                    <SettingsGroup className="bg-senary">
                        <SettingsRow
                            title="Scholarly search"
                            description="Let the model look up published research beyond your library. Its search query is sent to OpenAlex and Semantic Scholar."
                            control={
                                <input
                                    type="checkbox"
                                    aria-label="Scholarly search"
                                    checked={scholarlySearchPref}
                                    onChange={(e) => handleScholarlySearchToggle(e.target.checked)}
                                    onClick={(e) => e.stopPropagation()}
                                />
                            }
                        />
                        <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                            <div className="text-sm font-color-secondary mb-1">
                                Optional. Without a key, OpenAlex allows only a small daily search budget and
                                may refuse requests once it's spent. A free key raises that.
                            </div>
                            <ApiKeyInput
                                id="openalex-key"
                                label="OpenAlex API key"
                                verify={false}
                                value={openAlexKey}
                                onChange={setOpenAlexKey}
                                savePref={(newValue) => handlePrefSave('openAlexApiKey', newValue)}
                                placeholder="Optional"
                                linkUrl="https://openalex.org/settings/api"
                            />
                        </div>
                        <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                            <div className="text-sm font-color-secondary mb-1">
                                Optional. Raises Semantic Scholar's shared rate limit for these requests.
                            </div>
                            <ApiKeyInput
                                id="semantic-scholar-key"
                                label="Semantic Scholar API key"
                                verify={false}
                                value={semanticScholarKey}
                                onChange={setSemanticScholarKey}
                                savePref={(newValue) => handlePrefSave('semanticScholarApiKey', newValue)}
                                placeholder="Optional"
                                linkUrl="https://www.semanticscholar.org/product/api"
                            />
                        </div>
                        <SettingsRow
                            hasBorder
                            title="Web search"
                            description={localWebSearchDescription(localWebSearchStatus.kind, localWebSearchStatus.hostUnconfirmed)}
                            control={
                                <input
                                    type="checkbox"
                                    aria-label="Web search"
                                    checked={webSearchPref}
                                    onChange={(e) => handleWebSearchToggle(e.target.checked)}
                                    onClick={(e) => e.stopPropagation()}
                                />
                            }
                        />
                        <SettingsRow
                            hasBorder
                            title="Max searches per request"
                            description={LOCAL_WEB_SEARCH_MAX_USES_DESCRIPTION}
                            control={
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    value={maxUsesText}
                                    onChange={(e) => handleMaxUsesChange(e.target.value)}
                                    placeholder={String(DEFAULT_LOCAL_WEB_SEARCH_MAX_USES)}
                                    aria-label="Max searches per request"
                                    className="chat-input text-base font-color-primary"
                                    style={{ width: '80px', textAlign: 'right' }}
                                />
                            }
                        />
                    </SettingsGroup>
                </>
            )}

            <SectionDescription>
                {localModeActive ? (
                    <>
                        Connect your own local or self-hosted model below. Requests go straight from
                        this device to your endpoint — Beaver's backend is not involved.
                    </>
                ) : (
                    <>
                        Connect your own API keys (see our <DocLink path="api-key">guide</DocLink>),
                        or add a <DocLink path="custom-models">custom endpoint</DocLink>. Free and new paid keys (Tier 1) keys often hit rate limits. A key with higher rate limits works best (Tier 2+).
                        <DocLink path="api-key#why-beaver-needs-more-from-your-api-key"> Why?</DocLink>
                    </>
                )}
            </SectionDescription>

            {/* API Keys */}
            {!localModeActive && (
            <SettingsGroup className="bg-senary">
                <div style={{ padding: '8px 12px' }}>
                    <ApiKeyInput
                        id="gemini-key"
                        label="Google API Key"
                        provider="google"
                        value={geminiKey}
                        onChange={setGeminiKey}
                        savePref={(newValue) => handlePrefSave('googleGenerativeAiApiKey', newValue)}
                        placeholder="Enter your Google AI Studio API Key"
                        linkUrl="https://aistudio.google.com/app/apikey"
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <ApiKeyInput
                        id="openai-key"
                        label="OpenAI API Key"
                        provider="openai"
                        value={openaiKey}
                        onChange={setOpenaiKey}
                        savePref={(newValue) => handlePrefSave('openAiApiKey', newValue)}
                        placeholder="Enter your OpenAI API Key"
                        linkUrl="https://platform.openai.com/api-keys"
                    />
                </div>
                <div className="border-top-quinary" style={{ padding: '8px 12px' }}>
                    <ApiKeyInput
                        id="anthropic-key"
                        label="Anthropic API Key"
                        provider="anthropic"
                        value={anthropicKey}
                        onChange={setAnthropicKey}
                        savePref={(newValue) => handlePrefSave('anthropicApiKey', newValue)}
                        placeholder="Enter your Anthropic API Key"
                        linkUrl="https://console.anthropic.com/settings/keys"
                    />
                </div>
            </SettingsGroup>
            )}

            {/* Custom Providers */}
            <div>
                <div className="display-flex flex-row items-end justify-between">
                    <SectionLabel>Custom Providers</SectionLabel>
                    <Button
                        variant="outline"
                        icon={PlusSignIcon}
                        className="text-base mb-15"
                        onClick={handleAddProvider}
                        style={{ padding: '4px 6px' }}
                    >
                        Add Provider
                    </Button>
                </div>

                <div className="text-base font-color-secondary mb-2" style={{ paddingLeft: '2px' }}>
                    {localModeActive ? (
                        <>
                            OpenRouter, OpenAI-compatible proxies, or a local server such as Ollama or
                            LM Studio. Requests go straight from this device to the endpoint.
                        </>
                    ) : (
                        <>
                            OpenRouter, OpenAI-compatible proxies, or self-hosted HTTPS endpoints.
                            Requests are routed through Beaver's server. Each endpoint must be reachable from the public
                            internet over HTTPS.
                        </>
                    )}
                    {' '}<DocLink path="custom-models">Learn more</DocLink>
                </div>

                <div
                    className="display-flex flex-row items-start gap-2 rounded-md px-2 py-15 text-base mb-2"
                    style={{ border: '1px solid var(--tag-orange-tertiary)', background: 'var(--tag-orange-quinary)' }}
                >
                    <Icon icon={AlertIcon} className="flex-shrink-0 mt-020 stroke-width-2" style={{ color: 'var(--tag-orange-secondary)' }} />
                    <span style={{ color: 'var(--tag-orange)' }} >
                        <span className="font-medium">Choose a capable model.</span>
                        {' '}Beaver plans, calls tools, and reads long documents. Small or older
                        models often produce poor results. Pick a model scoring at
                        least <span className="font-medium">26</span> on the{' '}
                        <ExternalLink href={INTELLIGENCE_INDEX_URL}>Artificial Analysis Intelligence Index</ExternalLink>.
                        {' '}We recommend a score of <span className="font-medium">35</span> or higher for the best experience.
                    </span>
                </div>

                {customProviders.length > 0 ? (
                    <div className="display-flex flex-col" style={{ gap: '4px' }}>
                        {customProviders.map((entry) => (
                            <CustomProviderCard
                                key={entry._id}
                                model={entry.model}
                                onChange={(model) => handleProviderChange(entry._id, model)}
                                onRemove={() => handleRemoveProvider(entry._id)}
                                onDuplicate={() => handleDuplicateProvider(entry._id)}
                                isExpanded={entry._id === expandedProviderId}
                                onToggleExpand={() => handleToggleExpand(entry._id)}
                                autoFocusName={entry._id === autoFocusProviderId}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="text-base font-color-tertiary" style={{ paddingLeft: '2px' }}>
                        Click <span className="font-semibold" onClick={handleAddProvider}>Add Provider</span> to add custom endpoints
                    </div>
                )}
            </div>

            {/* Plus Tools */}
            {!localModeActive && (
            <>
            <div className="display-flex flex-row gap-2">
                <SectionLabel>Plus Tools</SectionLabel>
                {requestPlusTools ? (
                    remainingBeaverCredits > 0 ? (
                        <span
                            className="text-sm font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary"
                            style={{
                                marginTop: '20px', marginBottom: '6px',
                                backgroundColor: 'var(--tag-green-quinary)',
                                color: 'var(--tag-green-secondary)',
                                borderColor: 'var(--tag-green-tertiary)',
                            }}
                        >
                            Active
                        </span>
                    ) : (
                        <span
                            className="text-sm font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary"
                            style={{
                                marginTop: '20px', marginBottom: '6px',
                                backgroundColor: 'var(--tag-orange-quinary)',
                                color: 'var(--tag-orange-secondary)',
                                borderColor: 'var(--tag-orange-tertiary)',
                            }}
                        >
                            Paused &middot; No credits
                        </span>
                    )
                ) : (
                    <span
                        className="text-sm font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary"
                        style={{ marginTop: '20px', marginBottom: '6px' }}
                    >
                        Inactive
                    </span>
                )}
            </div>
            <SettingsGroup className="bg-senary">
                {requestPlusTools && remainingBeaverCredits > 0 ? (
                    /* State 1: Enabled + has credits */
                    <SettingsRow
                        className="items-start"
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                Plus tools include external search, batch extraction, and AI ranking with your own key for improved performance.
                                {/* <DocLink path="credits">See the benchmarks</DocLink> */}
                                {' '}<DocLink path="credits">Learn more</DocLink>
                                <br /><br />
                                <span className="font-semibold font-color-primary text-lg">{remainingBeaverCredits.toLocaleString()}</span>
                                {' '}<span className="font-color-primary text-base">credits left</span> 
                                <br />
                                <span className="font-color-secondary text-sm">
                                    Just 0.25 credits per message. Some actions cost extra.
                                </span>
                            </>
                        }
                        control={
                            <Button variant="outline" className="mt-1" onClick={handleRequestPlusToolsToggle} style={{ padding: '4px 6px' }}>
                                Disable
                            </Button>
                        }
                    />
                ) : requestPlusTools && remainingBeaverCredits <= 0 ? (
                    /* State 2: Enabled + no credits */
                    <SettingsRow
                        className="items-start"
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                You're out of credits, so Plus tools are paused. Your API key still works for basic chat.
                                Add credits for external search, batch extraction, and AI ranking.
                                <br />
                                <br />
                                <Button variant="outline" className="mt-1" onClick={handleRequestPlusToolsToggle} style={{ padding: '4px 6px' }}>
                                    Disable Plus Tools
                                </Button>
                            </>
                        }
                        control={
                            <Button variant="solid" className="mt-1" onClick={() => setActiveTab('billing')} style={{ padding: '4px 6px' }}>
                                Get credits &rarr;
                            </Button>
                        }
                    />
                ) : !requestPlusTools && remainingBeaverCredits > 0 ? (
                    /* State 3: Disabled + has credits */
                    <SettingsRow
                        className="items-start"
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                Plus tools include external search, batch extraction, and AI ranking with your own key for improved performance.
                                {/* <DocLink path="credits">See the benchmarks</DocLink> */}
                                {' '}<DocLink path="credits">Learn more</DocLink>
                                <br /><br />
                                <span className="font-semibold font-color-primary text-lg">{remainingBeaverCredits.toLocaleString()}</span>
                                {' '}<span className="font-color-primary text-base">credits ready to use</span> 
                                <br />
                                <span className="font-color-secondary text-sm">
                                    Just 0.25 credits per message. Some actions cost extra.
                                </span>
                            </>
                        }
                        control={
                            <Button variant="solid" className="mt-1" onClick={handleRequestPlusToolsToggle} style={{ padding: '4px 6px' }}>
                                Enable
                            </Button>
                        }
                    />
                ) : (
                    /* State 4: Disabled + no credits */
                    <SettingsRow
                        className="items-start"
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                Plus tools include external search, batch extraction, and AI ranking with your own key for improved performance.
                                Costs 0.25 credits per message. Some actions cost extra.{' '}
                                <DocLink path="credits">Learn more</DocLink>
                            </>
                        }
                        control={
                            <Button variant="solid" className="mt-1" onClick={() => {handleRequestPlusToolsToggle(); setActiveTab('billing')}} style={{ padding: '4px 6px' }}>
                                Get credits &rarr;
                            </Button>
                        }
                    />
                )}
            </SettingsGroup>
            </>
            )}

        </>
    );
};

export default ApiKeysSection;
