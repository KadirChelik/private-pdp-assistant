import { extractProductContext, getSuggestedQuestions, hasProductContext } from './extractor'
import {
  buildLocalExtractiveAnswer,
  getAssistantMode,
  requestCloudAnswer,
  resolveApiEndpoint,
} from './fallback'
import { isTurkishText, prepareQuestionEvidence } from './retrieval'
import { styles } from './styles'
import type { ChatTurn, ProductContext } from './types'

const conciergeIcon = `<svg viewBox="0 0 24 24" aria-hidden="true" class="pdp-brand-icon"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.35 0-2.62-.32-3.75-.88L3.5 20.5l1.38-4.75A8.46 8.46 0 0 1 4 11.5a8.5 8.5 0 1 1 17 0Z"/><path d="M8.75 10.25h6.5"/><path d="M8.75 13.75h4.25"/></svg>`
const sendIcon = `<svg viewBox="0 0 24 24" fill="none"><path d="m4 12 16-8-6 16-2.6-5.4L4 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`

type RuntimeMode = 'hybrid' | 'offline'

function buildKeyFacts(context: ProductContext): string[] {
  const facts: string[] = []
  const seen = new Set<string>()
  const pushFact = (text: string): void => {
    const trimmed = text.trim()
    const key = trimmed.toLocaleLowerCase()
    if (!trimmed || seen.has(key)) return
    seen.add(key)
    facts.push(trimmed)
  }

  for (const [key, rawValue] of Object.entries(context.specs)) {
    if (facts.length >= 3) break
    const value = rawValue.trim()
    if (!value || value.length > 36) continue
    const compactKey = key.trim()
    pushFact(compactKey && compactKey.length <= 24 ? `${compactKey}: ${value}` : value)
  }

  const sizeList = context.inStockSizes?.length ? context.inStockSizes : context.sizes
  if (facts.length < 4 && sizeList?.length) {
    const preview = sizeList.slice(0, 5).join(', ')
    const suffix = sizeList.length > 5 ? ` +${sizeList.length - 5}` : ''
    const isTr =
      document.documentElement.lang.toLocaleLowerCase().startsWith('tr') ||
      /ç|ğ|ı|ö|ş|ü|TL|₺/i.test(`${context.title ?? ''} ${context.listedPrice ?? ''}`)
    pushFact(`${isTr ? 'Stok' : 'Sizes'}: ${preview}${suffix}`)
  }

  if (facts.length < 4 && context.dimensionDetails?.bedSize) {
    pushFact(context.dimensionDetails.bedSize)
  }

  return facts.slice(0, 4)
}

export class AssistantWidget {
  private host: HTMLDivElement
  private root: ShadowRoot
  private scriptOrigin?: string
  private abort?: AbortController
  private sessionProductKey?: string
  private ready = false
  private currentRuntime: RuntimeMode = 'hybrid'
  private busy = false
  private disposed = false
  private history: ChatTurn[] = []
  private suggestedQuestions: string[] = []
  private suggestionDrag?: {
    pointerId: number
    startX: number
    scrollLeft: number
    moved: boolean
    question?: string
  }
  private suppressSuggestionClick = false

  constructor(host: HTMLDivElement, scriptOrigin?: string) {
    this.host = host
    this.scriptOrigin = scriptOrigin
    this.root = this.host.attachShadow({ mode: 'open' })
  }

  mount(): void {
    this.disposed = false
    this.root.innerHTML = `<style>${styles}</style>
      <button class="pdp-launcher" aria-label="Open product assistant" aria-expanded="false" aria-controls="pdp-assistant-panel">${conciergeIcon}<span class="pdp-launcher-label">Ask about product</span><span class="pdp-launcher-ring"></span></button>
      <section id="pdp-assistant-panel" class="pdp-panel pdp-hidden" role="dialog" aria-modal="true" aria-label="Product assistant">
        <header class="pdp-header"><div class="pdp-mark">${conciergeIcon}</div><div class="pdp-heading"><strong>Private PDP Assist</strong><span class="pdp-header-sub"><i class="pdp-dot"></i> Local-retrieval product assistant</span></div><button class="pdp-icon pdp-close" aria-label="Close"><span aria-hidden="true">×</span></button></header>
        <main class="pdp-body" aria-live="polite"></main>
        <footer class="pdp-composer pdp-hidden"><div class="pdp-suggestions" aria-label="Suggested questions"></div><form class="pdp-form"><input aria-label="Ask about this product" placeholder="Ask about this product…" maxlength="500" autocomplete="off"><button class="pdp-send" aria-label="Send" disabled>${sendIcon}</button></form><div class="pdp-privacy">Local retrieval · Only matched facts leave device when cloud needed</div></footer>
      </section>`
    this.applyChromeLanguage(this.isDocumentTurkish())
    this.bind()
  }

  unmount(): void {
    this.disposed = true
    this.abort?.abort()
    this.host.remove()
  }

  refresh(): void {
    if (this.disposed || this.busy) return
    const context = extractProductContext()
    const panel = this.q<HTMLElement>('.pdp-panel')
    const isOpen = !panel.classList.contains('pdp-hidden')
    const isTr = this.isDocumentTurkish()
    this.applyChromeLanguage(isTr)
    if (!hasProductContext(context)) {
      this.ready = false
      if (isOpen) {
        this.showState(
          'empty',
          isTr ? 'Ürün bulunamadı' : 'No product found',
          isTr
            ? 'Bu sayfada görünür ürün bilgisi bulunamadı.'
            : 'I couldn’t find enough visible product information on this page.',
        )
      }
      return
    }
    const nextKey = this.productKey(context)
    const changed = nextKey !== this.sessionProductKey
    this.sessionProductKey = nextKey
    if (isOpen) {
      if (changed || !this.ready) {
        this.ready = true
        this.showReady(context, false)
      }
    } else if (changed) {
      this.ready = false
    }
  }

  private bind(): void {
    const launcher = this.q<HTMLButtonElement>('.pdp-launcher')
    const panel = this.q<HTMLElement>('.pdp-panel')
    launcher.addEventListener('click', () => {
      const open = panel.classList.toggle('pdp-hidden') === false
      launcher.setAttribute('aria-expanded', String(open))
      if (open) {
        this.q<HTMLButtonElement>('.pdp-close').focus()
        if (!this.ready) {
          this.initialize()
        } else {
          const context = extractProductContext()
          if (hasProductContext(context) && this.productKey(context) !== this.sessionProductKey) {
            this.sessionProductKey = this.productKey(context)
            this.showReady(context)
          }
        }
      }
    })
    this.q('.pdp-close').addEventListener('click', () => this.closePanel())
    this.root.addEventListener('keydown', (event) => {
      if (!(event instanceof KeyboardEvent) || panel.classList.contains('pdp-hidden')) return
      if (event.key === 'Escape') {
        event.preventDefault()
        this.closePanel()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'))
        .filter((element) => element.getClientRects().length > 0)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && this.root.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && this.root.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    })
    const input = this.q<HTMLInputElement>('input')
    input.addEventListener('input', () => this.updateSendState())
    this.q<HTMLFormElement>('form').addEventListener('submit', (event) => {
      event.preventDefault()
      void this.ask(input.value.trim())
    })
    const suggestions = this.q<HTMLElement>('.pdp-suggestions')
    suggestions.addEventListener('pointerdown', (event) => this.startSuggestionDrag(event))
    suggestions.addEventListener('pointermove', (event) => this.moveSuggestionDrag(event))
    suggestions.addEventListener('pointerup', (event) => this.endSuggestionDrag(event))
    suggestions.addEventListener('pointercancel', (event) => this.endSuggestionDrag(event))
    suggestions.addEventListener('lostpointercapture', () => this.resetSuggestionDrag())
    suggestions.addEventListener('click', (event) => {
      if (this.suppressSuggestionClick) {
        event.preventDefault()
        event.stopPropagation()
        this.suppressSuggestionClick = false
        return
      }
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest<HTMLButtonElement>('.pdp-suggestion')
      const question = button?.dataset.question
      this.chooseSuggestedQuestion(question)
    })
  }

  private startSuggestionDrag(event: PointerEvent): void {
    if (event.button !== 0 && event.pointerType === 'mouse') return
    const suggestions = this.q<HTMLElement>('.pdp-suggestions')
    const target = event.target instanceof Element ? event.target : undefined
    const question = target?.closest<HTMLButtonElement>('.pdp-suggestion')?.dataset.question
    this.suggestionDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      scrollLeft: suggestions.scrollLeft,
      moved: false,
      question,
    }
    suggestions.setPointerCapture(event.pointerId)
    suggestions.classList.add('pdp-suggestions-dragging')
  }

  private moveSuggestionDrag(event: PointerEvent): void {
    const drag = this.suggestionDrag
    if (!drag || drag.pointerId !== event.pointerId) return
    const suggestions = this.q<HTMLElement>('.pdp-suggestions')
    const delta = event.clientX - drag.startX
    if (Math.abs(delta) > 4) {
      drag.moved = true
      this.suppressSuggestionClick = true
      event.preventDefault()
    }
    suggestions.scrollLeft = drag.scrollLeft - delta
  }

  private endSuggestionDrag(event: PointerEvent): void {
    const drag = this.suggestionDrag
    if (!drag || drag.pointerId !== event.pointerId) return
    const suggestions = this.q<HTMLElement>('.pdp-suggestions')
    if (suggestions.hasPointerCapture(event.pointerId)) {
      suggestions.releasePointerCapture(event.pointerId)
    }
    if (!drag.moved && drag.question) {
      event.preventDefault()
      this.chooseSuggestedQuestion(drag.question)
      this.suppressSuggestionClick = true
    } else {
      this.suppressSuggestionClick = drag.moved
    }
    this.resetSuggestionDrag()
  }

  private resetSuggestionDrag(): void {
    this.suggestionDrag = undefined
    this.q<HTMLElement>('.pdp-suggestions').classList.remove('pdp-suggestions-dragging')
  }

  private chooseSuggestedQuestion(question: string | undefined): void {
    if (!question || this.busy) return
    const input = this.q<HTMLInputElement>('input')
    input.value = question
    void this.ask(question)
  }

  private initialize(): void {
    const isTr = this.isDocumentTurkish()
    this.applyChromeLanguage(isTr)
    try {
      const context = extractProductContext()
      if (!hasProductContext(context)) {
        this.ready = false
        this.showState(
          'empty',
          isTr ? 'Ürün bulunamadı' : 'No product found',
          isTr
            ? 'Bu sayfada görünür ürün bilgisi bulunamadı.'
            : 'I couldn’t find enough visible product information on this page.',
        )
        return
      }

      this.currentRuntime = getAssistantMode() === 'local-only' ? 'offline' : 'hybrid'
      this.sessionProductKey = this.productKey(context)
      this.history = []
      this.ready = true
      this.showReady(context)
    } catch (error) {
      if (this.disposed) return
      console.error('[PDP Assistant]', error)
      this.showState(
        'error',
        isTr ? 'Beklenmeyen hata' : 'Unexpected error',
        isTr ? 'Asistan başlatılamadı. Lütfen tekrar deneyin.' : 'The assistant could not start. Please try again.',
        true,
      )
    }
  }

  private async ask(question: string): Promise<void> {
    if (this.disposed || !question || this.busy) return
    const input = this.q<HTMLInputElement>('input')
    this.busy = true
    this.q<HTMLButtonElement>('.pdp-send').disabled = true

    const context = extractProductContext()
    if (!hasProductContext(context)) {
      this.busy = false
      this.updateSendState()
      return
    }

    const productKey = this.productKey(context)
    if (productKey !== this.sessionProductKey) {
      this.sessionProductKey = productKey
      this.showReady(context, false)
    }

    const prepared = prepareQuestionEvidence(context, question)
    const isTurkish = prepared.isTurkish || this.contextNeedsTurkish(context)

    input.value = ''
    this.q('.pdp-body').setAttribute('aria-busy', 'true')
    this.appendMessage(question, 'user')

    const thinking = document.createElement('div')
    thinking.className = 'pdp-message pdp-assistant pdp-thinking'
    thinking.setAttribute('role', 'status')
    thinking.innerHTML = `<span class="pdp-loading-label">${isTurkish ? 'Yanıtlanıyor' : 'Thinking'}</span><i></i><i></i><i></i>`
    this.q('.pdp-messages').append(thinking)
    this.scroll()
    this.abort = new AbortController()

    try {
      // Short-circuit locally when no page evidence matches (0 ms, 0 network calls)
      if (!prepared.relevantEvidence.length) {
        thinking.remove()
        const gateMeta = isTurkish
          ? 'Yerel NOT_FOUND Koruması · 0 B gönderildi'
          : 'Local NOT_FOUND Gate · 0 B sent'
        this.appendMessage(prepared.notFoundText, 'assistant', gateMeta)
        return
      }

      let answerText: string | undefined
      let answerMeta = ''

      // Tier 1: Minimized-Evidence Cloud LLM (only matched facts + bounded 2-turn history)
      if (getAssistantMode() !== 'local-only') {
        try {
          const cloud = await requestCloudAnswer({
            endpoint: resolveApiEndpoint(this.scriptOrigin),
            question: prepared.cleanQuestion,
            productTitle: context.title || 'Unknown product',
            detectedIntent: prepared.detectedIntent,
            language: prepared.isTurkish ? 'tr' : 'en',
            evidence: prepared.evidenceLines,
            history: this.history.slice(-4),
            signal: this.abort.signal,
          })
          answerText = cloud.answer
          answerMeta = isTurkish
            ? `Minimal Bulut LLM (${cloud.provider}) · ${cloud.evidenceCount} kanıt (~${cloud.payloadBytes} B)`
            : `Minimized Cloud (${cloud.provider}) · ${cloud.evidenceCount} facts (~${cloud.payloadBytes} B)`
        } catch (cloudErr) {
          if ((cloudErr as DOMException)?.name === 'AbortError') throw cloudErr
        }
      }

      // Tier 2: Offline Local Extractive Fallback
      if (!answerText) {
        answerText = buildLocalExtractiveAnswer(
          prepared.detectedIntent,
          context,
          prepared.relevantEvidence,
          isTurkish,
        )
        answerMeta = isTurkish
          ? 'Yerel Özet Modu · 0 B gönderildi'
          : 'Offline Local Mode · 0 B sent'
      }

      thinking.remove()
      this.appendMessage(answerText, 'assistant', answerMeta)
      this.history.push(
        { role: 'user', text: prepared.cleanQuestion.slice(0, 280) },
        { role: 'assistant', text: answerText.slice(0, 280) },
      )
      this.history = this.history.slice(-4)
    } catch (error) {
      thinking.remove()
      if ((error as DOMException).name !== 'AbortError') {
        console.error('[PDP Assistant] Answer failed:', error)
        const fallback = buildLocalExtractiveAnswer(
          prepared.detectedIntent,
          context,
          prepared.relevantEvidence,
          isTurkish,
        )
        this.appendMessage(
          fallback,
          'assistant',
          isTurkish ? 'Yerel Özet Modu · 0 B' : 'Offline Local Mode · 0 B',
        )
      }
    } finally {
      this.busy = false
      this.abort = undefined
      if (this.disposed) return
      this.q('.pdp-body').setAttribute('aria-busy', 'false')
      this.updateSendState()
      input.focus()
    }
  }

  private runtimeBadgeText(isTurkish: boolean): { text: string; className: string; headerSub: string } {
    if (this.currentRuntime === 'offline') {
      return {
        text: isTurkish ? 'Yerel Özet Modu · 0 B ağ' : 'Offline Local Mode · Zero network',
        className: 'pdp-badge-offline',
        headerSub: isTurkish ? 'Sadece cihaz içi yerel mod' : 'Local-only offline mode',
      }
    }
    return {
      text: isTurkish ? 'Yerel Çıkarım + Minimal Bulut AI' : 'Local Retrieval + Minimized Cloud',
      className: 'pdp-badge-hybrid',
      headerSub: isTurkish ? '0 B indirme · Yerel çıkarım asistanı' : 'Zero-download · Local-retrieval AI',
    }
  }

  private showReady(context: ProductContext, focusInput = true): void {
    this.history = []
    const isTurkish = this.contextNeedsTurkish(context)
    const title = context.title || (isTurkish ? 'Ürün' : 'This product')
    const rating = context.rating
      ? `${context.rating} / 5${context.reviewCount ? ` · ${context.reviewCount} ${isTurkish ? 'yorum' : 'reviews'}` : ''}`
      : ''
    const facts = [
      context.listedPrice ? `<span class="pdp-listed-price">${this.escape(context.listedPrice)}</span>` : '',
      context.basketDiscountText ? `<span class="pdp-basket-price">${this.escape(context.basketDiscountText)}</span>` : '',
      rating ? `<span class="pdp-rating">★ ${this.escape(rating)}</span>` : '',
    ].filter(Boolean).join('')
    const brand = context.brand ? `<span class="pdp-product-brand">${this.escape(context.brand)}</span>` : ''
    const keyFacts = buildKeyFacts(context)
    const keyFactsMarkup = keyFacts.length
      ? `<div class="pdp-key-facts">${keyFacts.map((value) => `<span>${this.escape(value)}</span>`).join('')}</div>`
      : ''
    const runtime = this.runtimeBadgeText(isTurkish)
    this.q('.pdp-body').innerHTML = `<div class="pdp-product-summary"><div class="pdp-product-media" aria-hidden="true"></div><div class="pdp-product-content"><strong>${this.escape(title)}</strong>${brand}<div class="pdp-product-facts">${facts}</div>${keyFactsMarkup}<small class="pdp-runtime-badge ${runtime.className}">${this.escape(runtime.text)}</small></div></div><div class="pdp-messages"></div>`
    const headerSub = this.root.querySelector<HTMLElement>('.pdp-header-sub')
    if (headerSub) {
      headerSub.innerHTML = `<i class="pdp-dot"></i> ${this.escape(runtime.headerSub)}`
    }

    const media = this.q('.pdp-product-media')
    const imageUrl = context.image || context.images?.[0]
    if (imageUrl) {
      const image = document.createElement('img')
      image.src = imageUrl
      image.alt = ''
      image.loading = 'lazy'
      image.referrerPolicy = 'no-referrer'
      image.onerror = () => {
        media.textContent = title.charAt(0).toLocaleUpperCase()
      }
      media.append(image)
    } else {
      media.textContent = title.charAt(0).toLocaleUpperCase()
    }

    this.suggestedQuestions = getSuggestedQuestions(context)
    const suggestions = this.q('.pdp-suggestions')
    suggestions.replaceChildren(...this.suggestedQuestions.map((question) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'pdp-suggestion'
      button.dataset.question = question
      button.textContent = question
      return button
    }))

    this.applyChromeLanguage(isTurkish)

    this.q('.pdp-composer').classList.remove('pdp-hidden')
    if (focusInput) this.q<HTMLInputElement>('input').focus()
  }

  private showState(kind: string, title: string, message: string, retry = false): void {
    const isTr = this.isDocumentTurkish()
    this.applyChromeLanguage(isTr)
    const symbols: Record<string, string> = { empty: '⌕', unsupported: '!', loading: '···', error: '↻' }
    this.q('.pdp-composer').classList.add('pdp-hidden')
    const retryLabel = isTr ? 'Tekrar dene' : 'Try again'
    this.q('.pdp-body').innerHTML = `<div class="pdp-state"><div class="pdp-state-icon">${symbols[kind] ?? '!'}</div><strong>${this.escape(title)}</strong><p>${this.escape(message)}</p>${retry ? `<button class="pdp-retry">${retryLabel}</button>` : ''}</div>`
    this.root.querySelector('.pdp-retry')?.addEventListener('click', () => this.initialize())
  }

  private appendMessage(text: string, type: 'user' | 'assistant', meta?: string): void {
    const message = document.createElement('div')
    message.className = `pdp-message pdp-${type}`
    if (type === 'assistant' && meta) {
      const body = document.createElement('div')
      body.textContent = text
      const metaEl = document.createElement('div')
      metaEl.className = 'pdp-answer-meta'
      metaEl.textContent = meta
      message.append(body, metaEl)
    } else {
      message.textContent = text
    }
    this.q('.pdp-messages').append(message)
    this.scroll()
  }

  private scroll(): void { const body = this.q('.pdp-body'); body.scrollTop = body.scrollHeight }
  private closePanel(): void {
    this.q('.pdp-panel').classList.add('pdp-hidden')
    const launcher = this.q<HTMLButtonElement>('.pdp-launcher')
    launcher.setAttribute('aria-expanded', 'false')
    launcher.focus()
  }
  private productKey(context: ProductContext): string {
    return [
      context.url.split('#')[0],
      document.documentElement.lang || '',
      context.sku || '',
      context.title || '',
    ].join('|')
  }
  private isDocumentTurkish(): boolean {
    return document.documentElement.lang.toLocaleLowerCase().startsWith('tr')
  }
  private applyChromeLanguage(isTurkish: boolean): void {
    const launcher = this.root.querySelector<HTMLElement>('.pdp-launcher')
    if (launcher) launcher.setAttribute('aria-label', isTurkish ? 'Ürün asistanını aç' : 'Open product assistant')

    const launcherLabel = this.root.querySelector<HTMLElement>('.pdp-launcher-label')
    if (launcherLabel) launcherLabel.textContent = isTurkish ? 'Ürünü Sor' : 'Ask about product'

    const panel = this.root.querySelector<HTMLElement>('.pdp-panel')
    if (panel) panel.setAttribute('aria-label', isTurkish ? 'Ürün asistanı' : 'Product assistant')

    const close = this.root.querySelector<HTMLElement>('.pdp-close')
    if (close) close.setAttribute('aria-label', isTurkish ? 'Kapat' : 'Close')

    const suggestions = this.root.querySelector<HTMLElement>('.pdp-suggestions')
    if (suggestions) suggestions.setAttribute('aria-label', isTurkish ? 'Önerilen sorular' : 'Suggested questions')

    const input = this.root.querySelector<HTMLInputElement>('.pdp-form input')
    if (input) {
      const promptText = isTurkish ? 'Bu ürün hakkında soru sorun…' : 'Ask about this product…'
      input.setAttribute('aria-label', isTurkish ? 'Bu ürün hakkında soru sorun' : 'Ask about this product')
      input.placeholder = promptText
    }

    const send = this.root.querySelector<HTMLElement>('.pdp-send')
    if (send) send.setAttribute('aria-label', isTurkish ? 'Gönder' : 'Send')

    const privacy = this.root.querySelector<HTMLElement>('.pdp-privacy')
    if (privacy) {
      privacy.textContent = isTurkish
        ? 'Yerel ayrıştırma · Buluta yalnızca eşleşen kısa kanıtlar gider'
        : 'Local retrieval · Only matched evidence leaves device when cloud needed'
    }

    const headerSub = this.root.querySelector<HTMLElement>('.pdp-header-sub')
    if (headerSub && !this.ready) {
      headerSub.innerHTML = `<i class="pdp-dot"></i> ${this.escape(this.runtimeBadgeText(isTurkish).headerSub)}`
    }
  }
  private contextNeedsTurkish(context: ProductContext): boolean {
    if (document.documentElement.lang.toLocaleLowerCase().startsWith('tr')) return true
    const sample = [
      context.title,
      context.description,
      ...Object.entries(context.specs).flat(),
    ].filter((value): value is string => Boolean(value)).join(' ')
    return isTurkishText(sample)
  }
  private updateSendState(): void {
    const input = this.q<HTMLInputElement>('input')
    this.q<HTMLButtonElement>('.pdp-send').disabled = !input.value.trim() || this.busy
  }
  private q<T extends Element = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)! }
  private escape(value: string): string { const el = document.createElement('span'); el.textContent = value; return el.innerHTML }
}
