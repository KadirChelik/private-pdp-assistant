import { AssistantWidget } from './ui'
import { extractProductContext, getSuggestedQuestions } from './extractor'
import { buildEvidenceIndex, detectQuestionIntent, retrieveEvidence } from './nano'

const ROOT_ID = 'private-pdp-assistant-root'
let widget: AssistantWidget | undefined

const SCRIPT_ORIGIN = (() => {
  try {
    const script = document.currentScript as HTMLScriptElement | null
    return script?.src ? new URL(script.src, location.href).origin : undefined
  } catch {
    return undefined
  }
})()

function mount(): void {
  if (document.getElementById(ROOT_ID)) return

  const root = document.createElement('div')
  root.id = ROOT_ID
  root.dataset.pdpAssistant = ''
  root.style.position = 'fixed'
  root.style.right = '0'
  root.style.bottom = '0'
  root.style.zIndex = '2147483647'
  document.documentElement.append(root)

  widget = new AssistantWidget(root, SCRIPT_ORIGIN)
  widget.mount()
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
window.dispatchEvent(new CustomEvent('pdp-assistant:ready'))

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true })
} else {
  mount()
}
