# ![](/addon/content/icons/beaver_nomargin.png) Beaver Local

[![zotero target version](https://img.shields.io/badge/Zotero-7--10-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue?style=flat-square)](LICENSE)

**Beaver Local is a fork of [Beaver](https://github.com/jlegewie/beaver-zotero) for Zotero that runs on your own LLM provider.** It needs no account and talks to no Beaver servers: your library, your API key, your model.

Beaver is an AI research agent that lives inside Zotero, built by [jlegewie](https://github.com/jlegewie) at [beaverapp.ai](https://www.beaverapp.ai). This fork adds a **local mode**: the agent loop runs inside the plugin and calls your provider directly, while the chat UI stays the same.

> **Status: early.** All of local mode is unit-tested, but it has had little use in a real Zotero yet. Please [open an issue](https://github.com/chgwan/beaver-zotero-local/issues) with the Error Console output (Tools → Developer → Error Console) if something breaks.

---

## What local mode does

- **No login.** Bring your own API key; there is no Beaver account or subscription.
- **No Beaver servers.** Requests go only to your model endpoint and, if enabled, the scholarly search APIs. Backend access is blocked in every part of the plugin.
- **Any compatible provider.** OpenAI-compatible endpoints (OpenAI, OpenRouter, DeepSeek, local servers such as Ollama, LM Studio or vLLM) and the Anthropic Messages API.
- **Chat with your library.** The agent searches metadata and full text, lists items, collections, tags and libraries, reads notes and annotations, and reads PDF and EPUB attachments.
- **Reader integration.** Ask about the open paper, or run an action on a text selection or an annotation.
- **Scholarly search.** OpenAlex and Semantic Scholar, free and keyless by default, with optional keys for higher limits.
- **Web search.** Uses the provider's own hosted search tool (Anthropic, OpenAI, OpenRouter); toggle it with the globe icon in the composer.
- **Library exclusions.** Libraries you exclude in Preferences are never sent to the model.

### Not available in local mode

These upstream features depend on the Beaver backend:

- sentence-level citations and semantic (embedding) search
- write actions: annotating PDFs, editing notes, organizing the library
- threads that persist across restarts or sync across windows
- the MCP server and cloud OCR

---

## Install

1. Download `beaver-local.xpi` from the [latest release](https://github.com/chgwan/beaver-zotero-local/releases).
2. In Zotero, open **Tools → Plugins**, click the gear icon, choose **Install Plugin From File…** and select the `.xpi`.
3. Restart Zotero.

Beaver Local uses the same add-on ID as Beaver, so it **replaces** an installed official Beaver; the two cannot run side by side. Updates come only from this repository.

## Set up a provider

1. Open Beaver with the icon at the top right of the main window, or press **Ctrl+J** (**⌘J** on macOS).
2. Open Beaver **Preferences → API Keys → Local Mode**.
3. Add a provider:
   - **Endpoint:** for example `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `https://api.anthropic.com` or `http://localhost:11434/v1`
   - **API key:** may be left empty for a local server on `localhost`
   - **Format:** `openai` or `anthropic`
4. Use **Test Endpoint** to check the connection, then restart Zotero.
5. Pick the model in the composer and start chatting.

Optional settings:

- **Preferences → Search:** turn scholarly search on or off, add OpenAlex and Semantic Scholar API keys, allow web search and set the maximum searches per request.
- **Preferences → Advanced → Allow Library Access:** exclude libraries from the agent.

---

## Building from source

Requires Node.js 24 (Node 25 is not supported by `zotero-plugin-scaffold`).

```bash
git clone https://github.com/chgwan/beaver-zotero-local.git
cd beaver-zotero-local
npm ci
npm run build
```

The XPI is written to `.scaffold/build/beaver-local.xpi`. No server settings are needed: a build without Beaver backend configuration always starts in local mode.

Run the unit tests with `npm test`.

## Credits and license

Beaver is created by [jlegewie](https://github.com/jlegewie); see the [upstream repository](https://github.com/jlegewie/beaver-zotero) and [beaverapp.ai](https://www.beaverapp.ai) for the full, hosted version. Local mode is developed by [chgwan](https://github.com/chgwan).

Licensed under the [GNU Affero General Public License v3.0 or later](LICENSE), like upstream Beaver.
