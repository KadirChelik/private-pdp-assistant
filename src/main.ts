import { AssistantWidget } from './ui'
import { extractProductContext, getSuggestedQuestions } from './extractor'
import { buildEvidenceIndex, detectQuestionIntent, retrieveEvidence } from './retrieval'

const ROOT_ID = 'private-pdp-assistant-root'
let widget: AssistantWidget | undefined

const SCRIPT_ORIGIN = (() => {
  try {
    const current = document.currentScript as HTMLScriptElement | null
    if (current?.src) return new URL(current.src, location.href).origin
    const matched = document.querySelector<HTMLScriptElement>('script[src*="private-pdp-assistant"]')
    return matched?.src ? new URL(matched.src, location.href).origin : undefined
  } catch {
    return undefined
  }
})()

function mount(): void {
  const existing = document.getElementById(ROOT_ID)
  if (existing) {
    if (widget) {
      widget.refresh()
      return
    }
    existing.remove()
  }

  const root = document.createElement('div')
  root.id = ROOT_ID
  root.dataset.pdpAssistant = ''
  root.style.cssText = 'all:initial;position:fixed;right:0;bottom:0;z-index:2147483647;pointer-events:none;'
  ;(document.body || document.documentElement).append(root)

  widget = new AssistantWidget(root, SCRIPT_ORIGIN)
  widget.mount()
  console.info('[Private PDP Assistant] Mounted — click the floating assistant button at bottom-right.')
}

function unmount(): void {
  widget?.unmount()
  widget = undefined

  const root = document.getElementById(ROOT_ID)
  root?.remove()
}

function refresh(): void {
  widget?.refresh()
}

function debugContext() {
  const context = extractProductContext()
  const snapshot = {
    ...context,
    suggestedQuestions: getSuggestedQuestions(context),
  }

  console.log('[Private PDP Assistant] Extracted context:', snapshot)

  return snapshot
}

function debugEvidenceIndex() {
  return buildEvidenceIndex(extractProductContext())
}

function debugRetrieveEvidence(question: string) {
  return retrieveEvidence(question, debugEvidenceIndex())
}

window.PDPAssistant ??= { mount, unmount }
window.PDPAssistant.refresh = refresh
window.PDPAssistant.debugContext = debugContext
window.PDPAssistant.debugEvidenceIndex = debugEvidenceIndex
window.PDPAssistant.debugRetrieveEvidence = debugRetrieveEvidence
window.PDPAssistant.detectIntent = detectQuestionIntent
window.addEventListener('popstate', refresh)
window.addEventListener('hashchange', refresh)
window.dispatchEvent(new CustomEvent('pdp-assistant:ready'))

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true })
} else {
  mount()
}
