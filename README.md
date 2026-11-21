# Private PDP Assistant

A zero-network, dependency-free TypeScript + Vite widget that extracts structured product information directly from any product detail page (PDP) and answers shopper questions inside an isolated **Shadow DOM** panel using Chrome's on-device **Gemini Nano Prompt API** (`window.LanguageModel`). Turkish questions and Turkish storefronts are bridged locally via Chrome's built-in **Translator API** (`window.Translator`).

No API keys, no cloud LLM fallback, and **zero** network requests (`fetch`, `XHR`, or `WebSocket`) leave the user's browser.

**Live Demo & Pipeline Inspector:** `https://private-pdp-assistant.vercel.app`

---

## Architecture & Data Flow

```text
Product Page DOM / Schema.org JSON-LD
        │
        ▼  extractProductContext() (ignores [data-pdp-assistant] & [data-pdp-assistant-ignore])
Structured ProductContext (title, price, specs, reviews, Q&A)
        │
        ▼  buildEvidenceIndex() + detectQuestionIntent() + retrieveEvidence()
Ranked Top-K Grounded Evidence (or empty -> strict NOT_FOUND fallback)
        │
        ├──▶ Browser supports window.LanguageModel?
        │       ├── Yes -> On-device Gemini Nano session (+ optional local TR<->EN Translator bridge)
        │       └── No  -> Honest local-only notice + Local Extraction Preview inside Shadow DOM
        │                  (and interactive Pipeline Inspector on the demo storefront)
```

---

## Run Locally

```bash
npm install
npm run dev
```

Open the local URL in desktop Chrome. For live on-device generation, enable:
- `chrome://flags/#optimization-guide-on-device-model`
- `chrome://flags/#prompt-api-for-gemini-nano`

Relaunch Chrome and open the floating **Private PDP Assist** button in the bottom-right corner. Turkish chat also downloads Chrome's built-in `window.Translator` language packs on first use and runs offline afterward.

On browsers without Gemini Nano enabled, the widget displays a **Local Extraction Preview** inside the Shadow DOM panel, and the demo page includes an interactive **Live On-Device Pipeline Inspector** so any visitor can trace `ProductContext` extraction, intent detection, and evidence scoring live.

Run the dependency-free test suite (Node native test runner + `jsdom`):

```bash
npm test
```

---

## Build & Deploy

```bash
npm run build
```

This outputs:
- `dist/private-pdp-assistant.js` — standalone IIFE widget bundle (`ShadowRoot`-isolated, zero runtime dependencies)
- `dist/index.html` — demo PDP storefront + interactive Pipeline Inspector loading `/private-pdp-assistant.js`

Deploy `dist/` to Vercel, Netlify, Cloudflare Pages, or any static host. CORS headers for cross-origin DevTools injection are preconfigured in `vercel.json`.

### Inject on any product page via DevTools Console

```js
(()=>{const s=document.createElement('script');s.src='https://private-pdp-assistant.vercel.app/private-pdp-assistant.js';s.crossOrigin='anonymous';document.head.append(s)})()
```

Running the snippet more than once is idempotent. To remove or restore the widget:

```js
PDPAssistant.unmount()
PDPAssistant.mount()
```

---

## Diagnostics API

On any page where the widget is mounted, inspect extraction and retrieval in DevTools Console:

```js
PDPAssistant.debugContext()
PDPAssistant.debugEvidenceIndex()
PDPAssistant.debugRetrieveEvidence('What is the warranty?')
PDPAssistant.detectIntent('What do customer reviews say?')
```

`debugContext()` reports `priceSource` and `dataSource` so Schema.org JSON-LD priority vs. meta/DOM fallbacks are easy to verify.

---

## Privacy & Grounding Guarantees

- **Local extraction priority:** Prefers Schema.org JSON-LD `Product` data, falling back cleanly to metadata (`og:` / `itemprop`) and visible DOM attributes/tables/reviews.
- **On-device inference only:** Prompts are sent exclusively to `window.LanguageModel`; Turkish bridging uses `window.Translator`.
- **Zero telemetry or remote calls:** Zero runtime npm dependencies, zero analytics, zero `fetch` / `XMLHttpRequest` / `WebSocket` calls.
- **Strict page grounding:** Each question only sends ranked matching evidence from the fresh page snapshot; when no evidence matches, the model is instructed to return `"I could not find this information on the product page."` rather than guessing.
