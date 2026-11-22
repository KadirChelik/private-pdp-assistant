import type { QuestionIntent } from './retrieval'
import type { AssistantMode, ChatTurn, EvidenceItem, ProductContext } from './types'

export interface CloudAnswerRequest {
  endpoint: string
  question: string
  productTitle: string
  detectedIntent: QuestionIntent
  language: 'tr' | 'en'
  evidence: string[]
  history?: ChatTurn[]
  signal?: AbortSignal
}

export interface CloudAnswerResponse {
  answer: string
  provider: 'gemini' | 'groq' | 'openrouter'
  evidenceCount: number
  payloadBytes: number
}

const CLOUD_TIMEOUT_MS = 14_000
export const DEFAULT_CLOUD_ORIGIN = 'https://private-pdp-assistant.vercel.app'

export function getAssistantMode(): AssistantMode {
  if (typeof window !== 'undefined' && window.PDPAssistantConfig?.mode === 'local-only') {
    return 'local-only'
  }
  return 'hybrid'
}

export function resolveApiEndpoint(scriptOrigin?: string): string {
  if (typeof window !== 'undefined') {
    const configured = window.PDPAssistantConfig?.apiEndpoint?.trim()
    if (configured) return configured
  }
  if (scriptOrigin) {
    return `${scriptOrigin.replace(/\/$/, '')}/api/ask`
  }
  if (
    typeof location !== 'undefined' &&
    (location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1' ||
      location.origin === DEFAULT_CLOUD_ORIGIN)
  ) {
    return `${location.origin}/api/ask`
  }
  return `${DEFAULT_CLOUD_ORIGIN}/api/ask`
}

export async function requestCloudAnswer(
  req: CloudAnswerRequest,
): Promise<CloudAnswerResponse> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  req.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), CLOUD_TIMEOUT_MS)

  try {
    const response = await fetch(req.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: req.question,
        productTitle: req.productTitle,
        detectedIntent: req.detectedIntent,
        language: req.language,
        evidence: req.evidence,
        ...(req.history?.length ? { history: req.history.slice(-4) } : {}),
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Cloud fallback failed with HTTP ${response.status}`)
    }

    const data = (await response.json()) as Partial<CloudAnswerResponse>
    if (typeof data.answer !== 'string' || !data.answer.trim()) {
      throw new Error('Cloud fallback returned an empty answer')
    }

    return {
      answer: data.answer.trim(),
      provider: data.provider ?? 'gemini',
      evidenceCount:
        typeof data.evidenceCount === 'number' ? data.evidenceCount : req.evidence.length,
      payloadBytes: typeof data.payloadBytes === 'number' ? data.payloadBytes : 0,
    }
  } finally {
    clearTimeout(timer)
    req.signal?.removeEventListener('abort', onAbort)
  }
}

export function buildLocalExtractiveAnswer(
  intent: QuestionIntent,
  context: ProductContext,
  evidence: EvidenceItem[],
  isTurkish: boolean,
): string {
  const notFound = isTurkish
    ? 'Bu bilgiyi ürün sayfasında net olarak bulamadım.'
    : 'I could not find this information on the product page.'

  if (!evidence.length) return notFound

  if (intent === 'price') {
    const listed = context.listedPrice || context.price
    const basket = context.basketPrice
    if (basket && listed && basket !== listed) {
      return isTurkish
        ? `Ürünün liste fiyatı ${listed}, sepette indirimli fiyatı ise ${basket}.`
        : `The listed price is ${listed}, and the basket price is ${basket}.`
    }
    if (basket || listed) {
      const activePrice = basket || listed
      return isTurkish
        ? `Ürünün sayfadaki fiyatı ${activePrice}.`
        : `The product price is ${activePrice}.`
    }
  }

  if (intent === 'reviews') {
    const ratingPart = context.rating
      ? isTurkish
        ? `Ürün ${context.reviewCount ? `${context.reviewCount} yorumda ` : ''}${context.rating} / 5 puana sahip.`
        : `The product is rated ${context.rating} / 5${context.reviewCount ? ` across ${context.reviewCount} reviews` : ''}.`
      : ''
    const snippets = evidence
      .filter((item) => item.type === 'review')
      .slice(0, 2)
      .map((item) => `"${item.value}"`)
    if (ratingPart || snippets.length) {
      return [ratingPart, snippets.join(' ')].filter(Boolean).join(' ')
    }
  }

  if (intent === 'delivery') {
    const deliveryItems = evidence
      .filter((item) => item.type === 'shipping' || item.type === 'descriptionSentence' || item.type === 'availability')
      .slice(0, 2)
      .map((item) => item.value)
    if (deliveryItems.length) {
      return deliveryItems.join(' · ')
    }
  }

  if (intent === 'returnPolicy') {
    if (context.returnPolicyText) return context.returnPolicyText
    if (context.returnDays !== undefined) {
      return isTurkish
        ? `Sayfadaki bilgilere göre iade süresi ${context.returnDays} gündür.`
        : `According to the page details, returns are accepted within ${context.returnDays} days.`
    }
  }

  if (intent === 'summary') {
    const parts: string[] = []
    if (context.title) parts.push(context.title)
    const price = context.basketPrice || context.listedPrice
    if (price) parts.push(isTurkish ? `Fiyat: ${price}` : `Price: ${price}`)
    const topSpecs = Object.entries(context.specs)
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${v}`)
    if (topSpecs.length) parts.push(topSpecs.join(', '))
    if (context.rating) parts.push(`${context.rating} / 5`)
    if (parts.length) return `${parts.join(' · ')}.`
  }

  const topFacts = evidence.slice(0, 3).map((item) => {
    const cleanLabel = item.label && item.label !== 'Description' && item.label !== 'Visible page text'
      ? `${item.label}: `
      : ''
    return `${cleanLabel}${item.value}`
  })

  return topFacts.join(' · ') || notFound
}
