import { extractProductContext, getSuggestedQuestions, hasProductContext } from './extractor'
import { answerQuestion, createSession, isTurkishText, LOCAL_AI_UNAVAILABLE_MESSAGE, supportsNano } from './nano'
import { styles } from './styles'
import { createTurkishBridge, TURKISH_TRANSLATION_UNAVAILABLE } from './translation'
import type { AnswerLanguageBridge } from './translation'
import type { LanguageModelSession, ProductContext } from './types'

const robotIcon = `<svg viewBox="0 0 24 24" aria-hidden="true" class="pdp-robot-icon"><path d="M12 3v3"/><circle cx="12" cy="3" r="1"/><rect x="4.5" y="6" width="15" height="12.5" rx="4"/><path d="M4.5 11H3m18 0h-1.5M9 15h6"/><circle cx="9" cy="11.5" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="11.5" r="1" fill="currentColor" stroke="none"/></svg>`
const sendIcon = `<svg viewBox="0 0 24 24" fill="none"><path d="m4 12 16-8-6 16-2.6-5.4L4 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`

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
    if (facts.length >= 4) break
    const value = rawValue.trim()
    if (!value || value.length > 36) continue
    const compactKey = key.trim()
    pushFact(compactKey && compactKey.length <= 24 ? `${compactKey}: ${value}` : value)
  }

  if (facts.length < 4 && context.dimensionDetails?.bedSize) {
    pushFact(context.dimensionDetails.bedSize)
  }

  return facts.slice(0, 4)
}

export class AssistantWidget {
  private host: HTMLDivElement
  private root: ShadowRoot
  private session?: LanguageModelSession
  private abort?: AbortController
  private initAbort?: AbortController
  private languageBridge?: AnswerLanguageBridge
  private sessionProductKey?: string
  private sessionTurns = 0
  private busy = false
  private initializing = false
  private disposed = false
  private suggestedQuestions: string[] = []
  private suggestionDrag?: {
    pointerId: number
    startX: number
    scrollLeft: number
    moved: boolean
    question?: string
  }
  private suppressSuggestionClick = false

  constructor(host: HTMLDivElement) {
    this.host = host
    this.root = this.host.attachShadow({ mode: 'open' })
  }

  mount(): void {
    this.disposed = false
    this.root.innerHTML = `<style>${styles}</style>
      <button class="pdp-launcher" aria-label="Open product assistant" aria-expanded="false" aria-controls="pdp-assistant-panel">${robotIcon}<span class="pdp-launcher-ring"></span></button>
      <section id="pdp-assistant-panel" class="pdp-panel pdp-hidden" role="dialog" aria-modal="true" aria-label="Product assistant">
        <header class="pdp-header"><div class="pdp-mark">${robotIcon}</div><div class="pdp-heading"><strong>Private PDP Assist</strong><span><i class="pdp-dot"></i> On-device product intelligence</span></div><button class="pdp-icon pdp-close" aria-label="Close"><span aria-hidden="true">×</span></button></header>
        <main class="pdp-body" aria-live="polite"></main>
        <footer class="pdp-composer pdp-hidden"><div class="pdp-suggestions" aria-label="Suggested questions"></div><form class="pdp-form"><input aria-label="Ask about this product" placeholder="Ask about this product…" maxlength="500" autocomplete="off"><button class="pdp-send" aria-label="Send" disabled>${sendIcon}</button></form><div class="pdp-privacy">Product content is processed locally on this device</div></footer>
      </section>`
    this.bind()
  }

  unmount(): void {
    this.disposed = true
    this.abort?.abort()
    this.initAbort?.abort()
    this.session?.destroy()
    this.languageBridge?.destroy()
    this.session = undefined
    this.languageBridge = undefined
    this.host.remove()
  }

  private bind(): void {
    const launcher = this.q<HTMLButtonElement>('.pdp-launcher')
    const panel = this.q<HTMLElement>('.pdp-panel')
    launcher.addEventListener('click', () => {
      const open = panel.classList.toggle('pdp-hidden') === false
      launcher.setAttribute('aria-expanded', String(open))
      if (open) {
        this.q<HTMLButtonElement>('.pdp-close').focus()
        if (!this.session) void this.initialize()
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

  private async initialize(): Promise<void> {
    if (this.initializing) return
    this.initializing = true
    let context: ProductContext = { url: location.href, specs: {} }
    try {
      context = extractProductContext()
      if (!hasProductContext(context)) {
        this.showState('empty', 'No product found', 'I couldn’t find enough visible product information on this page.')
        return
      }
      if (!supportsNano()) {
        this.showUnsupported(context)
        return
      }
      this.showDownload(0, true)
      this.initAbort = new AbortController()
      const session = await createSession((percent) => {
        if (!this.disposed) this.showDownload(percent, false)
      }, this.initAbort.signal)
      if (this.disposed) {
        session.destroy()
        return
      }
      this.session = session
      this.sessionProductKey = this.productKey(context)
      this.sessionTurns = 0
      this.showReady(context)
    } catch (error) {
      if (this.disposed) return
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        this.showState('error', 'Activation required', 'Close and reopen the assistant, then start the local model again.', true)
      } else if (error instanceof DOMException && error.name === 'NotSupportedError') {
        this.showUnsupported(context, true)
      } else {
        console.error('[PDP Assistant]', error)
        this.showState('error', 'Unexpected error', 'The assistant could not start. Please try again.', true)
      }
    } finally {
      this.initAbort = undefined
      this.initializing = false
    }
  }

  private async ask(question: string): Promise<void> {
    if (this.disposed || !question || !this.session || this.busy) return
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
    const productChanged = productKey !== this.sessionProductKey
    const needsFreshSession = productChanged || this.sessionTurns >= 4
    const freshSessionPromise = needsFreshSession
      ? createSession((percent) => {
          if (!this.disposed && productChanged) this.showDownload(percent, false)
        })
      : undefined
    const needsLanguageBridge = (isTurkishText(question) || this.contextNeedsTurkish(context)) && !this.languageBridge
    const bridgePromise = needsLanguageBridge
      ? createTurkishBridge(() => undefined)
      : undefined

    if (productChanged) this.showDownload(0, true)
    try {
      const [freshSession, freshBridge] = await Promise.all([freshSessionPromise, bridgePromise])
      if (freshSession) {
        this.session.destroy()
        this.session = freshSession
        this.sessionProductKey = productKey
        this.sessionTurns = 0
        if (productChanged) this.showReady(context)
      }
      if (freshBridge) this.languageBridge = freshBridge
    } catch (error) {
      if (productChanged) this.showReady(context)
      if (error instanceof DOMException && error.name === 'NotSupportedError' && needsLanguageBridge) {
        this.appendMessage(TURKISH_TRANSLATION_UNAVAILABLE, 'assistant')
      } else {
        this.appendMessage('The local AI resources could not be prepared. Please try again.', 'assistant')
      }
      this.busy = false
      this.updateSendState()
      return
    }

    input.value = ''
    this.q('.pdp-body').setAttribute('aria-busy', 'true')
    this.appendMessage(question, 'user')
    const thinking = document.createElement('div')
    thinking.className = 'pdp-message pdp-assistant pdp-thinking'
    thinking.setAttribute('role', 'status')
    thinking.innerHTML = '<span class="pdp-loading-label">Thinking</span><i></i><i></i><i></i>'
    this.q('.pdp-messages').append(thinking)
    this.scroll()
    this.abort = new AbortController()
    try {
      const bridge = (isTurkishText(question) || this.contextNeedsTurkish(context)) ? this.languageBridge : undefined
      const answer = await answerQuestion(this.session, context, question, this.abort.signal, bridge, isTurkishText(question))
      thinking.remove()
      this.appendMessage(answer, 'assistant')
      this.sessionTurns += 1
    } catch (error) {
      thinking.remove()
      if ((error as DOMException).name !== 'AbortError') {
        if (!(error instanceof DOMException) || !['NotSupportedError', 'QuotaExceededError'].includes(error.name)) {
          console.error('[PDP Assistant] Answer failed:', error)
        }
        if (error instanceof DOMException && error.name === 'QuotaExceededError') {
          this.session.destroy()
          this.sessionTurns = 4
        }
        const message = error instanceof DOMException && error.name === 'NotSupportedError'
          ? (isTurkishText(question) ? TURKISH_TRANSLATION_UNAVAILABLE : 'This language or input is not supported by the local model.')
          : error instanceof DOMException && error.name === 'QuotaExceededError'
            ? 'The local conversation limit was reached. Send the question again to start a fresh session.'
            : 'An unexpected error occurred while generating the answer. Please try again.'
        this.appendMessage(message, 'assistant')
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

  private showReady(context: ProductContext): void {
    const title = context.title || 'This product'
    const rating = context.rating
      ? `${context.rating} / 5${context.reviewCount ? ` · ${context.reviewCount} reviews` : ''}`
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
    this.q('.pdp-body').innerHTML = `<div class="pdp-product-summary"><div class="pdp-product-media" aria-hidden="true"></div><div class="pdp-product-content"><strong>${this.escape(title)}</strong>${brand}<div class="pdp-product-facts">${facts}</div>${keyFactsMarkup}<small>Local Gemini Nano · Page-grounded</small></div></div><div class="pdp-messages"></div>`
    const media = this.q('.pdp-product-media')
    const imageUrl = context.image || context.images?.[0]
    if (imageUrl) {
      const image = document.createElement('img')
      image.src = imageUrl
      image.alt = ''
      image.loading = 'lazy'
      image.referrerPolicy = 'no-referrer'
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
    this.q('.pdp-composer').classList.remove('pdp-hidden')
    this.q<HTMLInputElement>('input').focus()
  }

  private showUnsupported(context: ProductContext, retry = false): void {
    this.q('.pdp-composer').classList.add('pdp-hidden')
    const sourceBadge = context.dataSource?.some((item) => item.includes('json-ld'))
      ? 'json-ld'
      : 'dom'
    const price = context.basketPrice || context.listedPrice || ''
    const rating = context.rating
      ? `★ ${context.rating} / 5${context.reviewCount ? ` (${context.reviewCount})` : ''}`
      : ''
    const specs = Object.entries(context.specs).slice(0, 4)
    const specsMarkup = specs.length
      ? `<ul class="pdp-preview-specs">${specs.map(([key, value]) => `<li><span>${this.escape(key)}</span><strong>${this.escape(value)}</strong></li>`).join('')}</ul>`
      : ''
    const hasInspector = Boolean(document.getElementById('pipeline-inspector'))
    const inspectorCta = hasInspector
      ? '<button type="button" class="pdp-preview-cta">Open Pipeline Inspector ↓</button>'
      : ''

    this.q('.pdp-body').innerHTML = `
      <div class="pdp-state pdp-state-compact">
        <div class="pdp-state-icon">!</div>
        <strong>${retry ? 'Local AI unavailable' : 'Unsupported browser'}</strong>
        <p>${this.escape(LOCAL_AI_UNAVAILABLE_MESSAGE)}</p>
        ${retry ? '<button class="pdp-retry">Try again</button>' : ''}
      </div>
      <div class="pdp-preview-card">
        <div class="pdp-preview-head">
          <span>Local Extraction Preview</span>
          <span class="pdp-preview-badge">${this.escape(sourceBadge)}</span>
        </div>
        <div class="pdp-preview-title">${this.escape(context.title || 'Detected Product')}</div>
        ${(price || rating) ? `<div class="pdp-preview-meta">${price ? `<span class="pdp-preview-price">${this.escape(price)}</span>` : ''}${rating ? `<span>${this.escape(rating)}</span>` : ''}</div>` : ''}
        ${specsMarkup}
        ${inspectorCta}
      </div>`

    this.root.querySelector('.pdp-retry')?.addEventListener('click', () => void this.initialize())
    this.root.querySelector('.pdp-preview-cta')?.addEventListener('click', () => {
      this.closePanel()
      const inspector = document.getElementById('pipeline-inspector')
      inspector?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      document.getElementById('inspector-question')?.focus({ preventScroll: true })
    })
  }

  private showDownload(percent: number, waitingToStart: boolean): void {
    this.q('.pdp-composer').classList.add('pdp-hidden')
    this.q('.pdp-body').innerHTML = `<div class="pdp-state" role="status"><div class="pdp-state-icon">↓</div><strong>${waitingToStart ? 'Local AI download required' : 'Local AI download in progress'}</strong><p>Chrome is preparing Gemini Nano on this device. Keep this page open.</p><div class="pdp-progress"><span style="width:${percent}%"></span></div><p>${percent ? `${percent}%` : 'Starting…'}</p></div>`
  }

  private showState(kind: string, title: string, message: string, retry = false): void {
    const symbols: Record<string, string> = { empty: '⌕', unsupported: '!', loading: '···', error: '↻' }
    this.q('.pdp-composer').classList.add('pdp-hidden')
    this.q('.pdp-body').innerHTML = `<div class="pdp-state"><div class="pdp-state-icon">${symbols[kind] ?? '!'}</div><strong>${title}</strong><p>${message}</p>${retry ? '<button class="pdp-retry">Try again</button>' : ''}</div>`
    this.root.querySelector('.pdp-retry')?.addEventListener('click', () => void this.initialize())
  }

  private appendMessage(text: string, type: 'user' | 'assistant'): void {
    const message = document.createElement('div')
    message.className = `pdp-message pdp-${type}`
    message.textContent = text
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
    return [context.url.split('#')[0], context.sku || '', context.title || ''].join('|')
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
