# Private PDP Assistant

A category-agnostic, local-first **3-tier hybrid** e-commerce product assistant widget built with **TypeScript, Shadow DOM, and Vite IIFE** (zero runtime npm dependencies) paired with a minimal-evidence serverless fallback (`api/ask.ts`).

**Live 3-Category Demo & Inspector:** https://private-pdp-assistant.vercel.app

---

## Why 3-Tier Local-First Hybrid?

Forcing shoppers on an e-commerce store to download a ~1.5 GB browser AI model or showing an `"Unsupported browser"` wall kills conversion. Instead, Private PDP Assistant runs **all extraction, intent detection, and evidence retrieval locally in the browser** and selects the fastest available inference path with **zero forced downloads**:

```text
Product Page DOM / Schema.org JSON-LD (any category: outdoor, footwear, apparel, electronics...)
        │
        ▼  extractProductContext() + buildEvidenceIndex() + retrieveEvidence()   [100% local]
        │
        ├── No matching evidence? ──▶ Local NOT_FOUND Gate (0 ms, 0 bytes, $0 API cost)
        │
        ├── Tier 1: Chrome Gemini Nano already 'available' locally?
        │       └── Yes ─▶ Isolated On-Device Session (0 B network, $0 API cost)
        │
        ├── Tier 2: Any other browser (Safari, Firefox, Mobile, Nano not downloaded)
        │       └── Minimized-Evidence Cloud (/api/ask: Gemini -> Groq -> OpenRouter)
        │           Sends ONLY 1-10 matched facts (~150-350 B, zero HTML, zero PII)
        │
        └── Tier 3: Offline / local-only mode / cloud unavailable
                └── Category-Agnostic Local Extractive Synthesizer (0 B network)
```

---

## Features

- **Category-Agnostic Extraction (`src/extractor.ts`):** Prioritizes Schema.org `Product` JSON-LD with controlled fallbacks to meta tags and visible DOM specs, basket discounts (`.discount-price`), ratings, and customer reviews.
- **Zero-Noise Local Retrieval (`src/nano.ts`):** Detects TR/EN shopping intents (`price`, `capacity`, `material`, `reviews`, `delivery`, `returnPolicy`, `suitability`, `summary`, etc.), scores ranked evidence, prevents false positives on absent attributes, and strips duplicate review/UI noise.
- **Zero Forced 1.5 GB Downloads (`src/ui.ts`):** Checks `window.LanguageModel.availability()` and uses Gemini Nano *only* when `availability === 'available'`. Every browser (Safari, Firefox, Mobile, Chrome) opens chat immediately.
- **Minimized-Payload Cloud Fallback (`api/ask.ts`):** Serverless endpoint with strict IP rate limiting (15 req/min), 8 KB body cap, strict PDP-evidence schema validation, HTML payload rejection, and multi-provider fallback (`Gemini -> Groq -> OpenRouter`).
- **Embeddable Shadow DOM Widget:** Zero external runtime dependencies, encapsulated CSS, focus trap, swipeable suggested questions, and `window.PDPAssistant.refresh()` for SPA storefronts.

---

## Configuration & DevTools Injection

Inject on any product detail page from DevTools Console:

```js
(()=>{const s=document.createElement('script');s.src='https://private-pdp-assistant.vercel.app/private-pdp-assistant.js';s.crossOrigin='anonymous';document.head.append(s)})()
```

Optional runtime configuration before or after loading:

```js
window.PDPAssistantConfig = {
  mode: 'hybrid', // or 'local-only' (disables Tier 2 cloud fallback completely)
  apiEndpoint: 'https://your-domain.example/api/ask',
}
```

Lifecycle & diagnostics API:

```js
PDPAssistant.refresh()
PDPAssistant.unmount()
PDPAssistant.mount()
PDPAssistant.debugContext()
PDPAssistant.debugEvidenceIndex()
PDPAssistant.debugRetrieveEvidence('Geniş taraklı ayağa olur mu?')
```

---

## Run Locally & Test

```bash
npm install
npm test        # Node native test runner + jsdom
npm run build   # Builds dist/private-pdp-assistant.js + dist/index.html
npm run dev     # Local Vite dev server
```

To run Tier 2 Cloud Fallback locally, deploy on Vercel (`vercel dev` or production) with `GEMINI_API_KEY`, `GROQ_API_KEY`, and/or `OPENROUTER_API_KEY`. Without any API keys configured, `/api/ask` returns `503` and the widget automatically falls back to Tier 3 (`Offline Local Mode`).
