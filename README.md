# Private PDP Assistant

A category-agnostic, **privacy-first local-retrieval AI product widget** built with **TypeScript, Shadow DOM, and Vite IIFE** (zero runtime npm dependencies) paired with a minimal-evidence serverless synthesis proxy (`api/ask.ts`).

**Live 3-Category Demo & Inspector:** https://private-pdp-assistant.vercel.app

---

## How Local Retrieval + Minimized Cloud Works

Instead of shipping raw page HTML, session cookies, or shopper PII to a backend, Private PDP Assistant runs **all DOM/JSON-LD extraction, intent detection, Turkish/English stemming, and out-of-page gating locally in the shopper's browser**:

```text
Product Page DOM / Schema.org JSON-LD (outdoor, footwear, apparel, electronics, books, furniture...)
        │
        ▼  extractProductContext() + buildEvidenceIndex() + retrieveEvidence()   [100% local]
        │
        ├── No matching evidence? ──▶ Local NOT_FOUND Gate (0 ms, 0 bytes, $0 API cost)
        │
        ├── Hybrid Mode (default):
        │       └── Minimized-Evidence Cloud (/api/ask: Gemini -> Groq -> OpenRouter)
        │           Sends ONLY 1-8 matched fact strings + 2-turn follow-up context (0 HTML, 0 PII)
        │
        └── Offline / local-only / Cloud Unavailable:
                └── Category-Agnostic Local Extractive Synthesizer (0 B network)
```

---

## Architecture Decision: Why We Dropped On-Device Gemini Nano

This project originally prototyped Chrome's experimental Prompt API (Gemini Nano) + Translator API for 100% on-device inference. Benchmarking across real Turkish and English product pages revealed four structural issues for real shoppers:

1. **Conversion-killing ~1.5 GB model download & poor browser support:** Unavailable on Safari, Firefox, mobile browsers, and most Chrome sessions without prior model opt-in.
2. **Low small-model reasoning accuracy:** Prone to truncation, false negatives on inflected queries, and prompt/quota exhaustion (`QuotaExceededError`).
3. **TR ↔ EN Translator bridge distortion:** Chrome Prompt API rejected native Turkish output, forcing two-way translation (`tr -> en -> Prompt -> tr`) that corrupted domain phrasing (e.g., *kalıp*, *astar*, *baza*).
4. **Simpler, higher-precision privacy model:** Doing extraction, scoring, and `NOT_FOUND` filtering locally — and sending **only matched short evidence strings** (~200–1,100 B, zero HTML, zero cookies, zero PII) — preserves data minimization while working instantaneously on every browser.

---

## Features

- **Cross-Storefront Extraction (`src/extractor.ts`):** Prioritizes Schema.org `Product` / `ProductGroup` / `Book` / `AggregateOffer` JSON-LD (with HTML-entity decoding and `hasMerchantReturnPolicy` support) plus split-container and collapsed accordion spec tables, DIV/P attribute lists, basket discounts, ratings, and reviews while excluding assistant and carousel/nav containers.
- **Zero-Noise Local Retrieval & Follow-Up Memory (`src/retrieval.ts`):** Recognizes TR/EN shopping intents (`price`, `dimensions`, `fit`, `care`, `material`, `color`, `delivery`, `returnPolicy`, `reviews`, `suitability`, `summary`), handles Turkish suffix stripping + consonant de-mutation, supports compound multi-attribute queries, and resolves bounded 2-turn follow-ups (`"Peki neden?"`, `"Explain more"`) without relaxing out-of-page `0 B` NOT_FOUND protection.
- **Hardened Cloud Synthesis (`api/ask.ts`):** Serverless endpoint with 15 req/60s IP rate limit (`429`), 8 KB payload cap (`413`), strict JSON schema & HTML rejection (`400`), bounded `history` (`<= 4` turns), and `Gemini -> Groq -> OpenRouter` fallback.
- **Embeddable Shadow DOM Widget (`src/ui.ts`, `src/main.ts`):** Zero runtime dependencies, `all:initial` CSS isolation, keyboard focus trap, swipeable dynamic suggestions tailored per PDP, broken-image fallback, and SPA URL/DOM `refresh()`.

---

## Configuration & DevTools Injection

Paste on any CSP-permissive product detail page from DevTools Console:

```js
(()=>{const s=document.createElement('script');s.src='https://private-pdp-assistant.vercel.app/private-pdp-assistant.js';s.onerror=()=>console.warn('[PDP Assistant] Blocked by this site CSP.');document.head.append(s)})()
```

Optional runtime configuration before or after loading:

```js
window.PDPAssistantConfig = {
  mode: 'hybrid', // or 'local-only' (disables /api/ask calls completely)
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

To run Cloud Synthesis locally, deploy on Vercel (`vercel dev` or production) with `GEMINI_API_KEY`, `GROQ_API_KEY`, and/or `OPENROUTER_API_KEY`. Without any API keys configured, `/api/ask` returns `503` and the widget automatically falls back to `Offline Local Mode`.
