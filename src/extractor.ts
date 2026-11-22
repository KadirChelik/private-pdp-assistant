import type { ProductContext, ProductQna, ProductReview, ReviewSummary } from './types'

type JsonObject = Record<string, unknown>

const MAX_SAMPLE_CHARS = 4_000
const MAX_FEATURES = 10
const REVIEW_THEME_KEYWORDS = {
  delivery: ['teslim', 'teslimat', 'kapı', 'kata', 'kargo'],
  packaging: ['ambalaj', 'paket', 'tertemiz', 'özenli'],
  usability: ['kullanışlı', 'rahat', 'f/p', 'memnun', 'kaliteli'],
  assembly: ['montaj', 'demonte', 'kurulum'],
} as const
const PRICE_NOISE = /kupon|coupon|kargo|cargo|shipping|taksit|installment|indirim|discount|puan|points|montaj|service|hizmet|kampanya|delivery\s*fee/i
const PRODUCT_ROOT_SELECTORS = [
  '[data-testid*="product-detail"]',
  '[class*="product-detail" i]',
  '[class*="product_detail" i]',
  'main[itemtype*="schema.org/Product"]',
  'main[itemtype*="schema.org/product"]',
  'main',
  '[itemtype*="schema.org/Product"]',
  '[itemtype*="schema.org/product"]',
]

const clean = (value: string | null | undefined): string =>
  (value ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()

const compact = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
}

function decodeHtmlEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (full, hex, dec, named) => {
    if (hex) {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : full
    }
    if (dec) {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : full
    }
    const replacement = named ? NAMED_HTML_ENTITIES[named.toLowerCase()] : undefined
    return replacement ?? full
  })
}

function scalar(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return clean(decodeHtmlEntities(String(value)))
  }
  return ''
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function firstObject(value: unknown): JsonObject | undefined {
  if (Array.isArray(value)) return value.map(object).find(Boolean)
  return object(value)
}

function objects(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.map(object).filter((item): item is JsonObject => Boolean(item))
  const item = object(value)
  return item ? [item] : []
}

function isProduct(value: JsonObject): boolean {
  const type = value['@type']
  const types = Array.isArray(type) ? type : [type]
  if (types.includes('Product') || types.includes('ProductGroup')) return true
  if (types.includes('Book')) {
    return Boolean(value.offers || (value.name && (value.author || value.isbn || value.bookFormat || value.numberOfPages)))
  }
  return false
}

function collectProducts(value: unknown, products: JsonObject[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectProducts(item, products))
    return
  }
  const item = object(value)
  if (!item) return
  if (isProduct(item)) products.push(item)
  Object.values(item).forEach((child) => collectProducts(child, products))
}

function parseJsonLdProducts(): JsonObject[] {
  const products: JsonObject[] = []
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
    try {
      collectProducts(JSON.parse(script.textContent || ''), products)
    } catch {
      // Invalid JSON-LD should not prevent DOM fallback extraction.
    }
  }
  return products
}

function isVisible(element: HTMLElement): boolean {
  if (element.closest('script,style,noscript,svg,canvas,template,[hidden],[aria-hidden="true"],[data-pdp-assistant],[data-pdp-assistant-ignore]')) return false
  let current: HTMLElement | null = element
  while (current) {
    const style = getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    current = current.parentElement
  }
  return element.getClientRects().length > 0
}

function textOf(element: HTMLElement | null): string {
  return element && isVisible(element) ? clean(element.innerText || element.textContent) : ''
}

function unique(values: string[], limit = Number.POSITIVE_INFINITY): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values.map(clean)) {
    const key = value.toLocaleLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    result.push(value)
    if (result.length >= limit) break
  }
  return result
}

function firstText(scope: ParentNode, selectors: string[]): string {
  for (const selector of selectors) {
    for (const element of scope.querySelectorAll<HTMLElement>(selector)) {
      const value = textOf(element)
      if (value) return value
    }
  }
  return ''
}

function attributeOrText(scope: ParentNode, selectors: string[]): string {
  for (const selector of selectors) {
    for (const element of scope.querySelectorAll<HTMLElement>(selector)) {
      if (element.closest('[data-pdp-assistant],[data-pdp-assistant-ignore]')) continue
      const value = clean(element.getAttribute('content') || element.getAttribute('data-price') || textOf(element))
      if (value) return value
    }
  }
  return ''
}

function metaContent(selectors: string[]): string {
  for (const selector of selectors) {
    const value = clean(document.querySelector<HTMLMetaElement>(selector)?.content)
    if (value) return value
  }
  return ''
}

function findProductRoot(): HTMLElement {
  for (const selector of PRODUCT_ROOT_SELECTORS) {
    const root = document.querySelector<HTMLElement>(selector)
    if (root && isVisible(root)) return root
  }
  return document.body
}

function visibleTextChunks(root: HTMLElement): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  let totalChars = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (!parent || !isVisible(parent)) continue
    if (parent.closest('nav,footer,header,button,input,select,textarea,[role="button"],[role="navigation"]')) continue
    const value = compact(clean(node.textContent), 320)
    const key = value.toLocaleLowerCase()
    if (value.length < 2 || seen.has(key)) continue
    seen.add(key)
    result.push(value)
    totalChars += value.length + 1
    if (totalChars >= MAX_SAMPLE_CHARS * 2) break
  }
  return result
}

function normalizeAvailability(value: unknown): string {
  return scalar(value).split('/').filter(Boolean).pop() || ''
}

function parseAmount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  let text = scalar(value).replace(/[^\d.,-]/g, '')
  if (!text) return undefined
  const lastDot = text.lastIndexOf('.')
  const lastComma = text.lastIndexOf(',')
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ','
    text = text.replace(decimal === '.' ? /,/g : /\./g, '').replace(decimal, '.')
  } else if (lastComma >= 0) {
    const decimals = text.length - lastComma - 1
    text = decimals === 3 ? text.replace(/,/g, '') : text.replace(',', '.')
  } else if (lastDot >= 0 && text.length - lastDot - 1 === 3) {
    text = text.replace(/\./g, '')
  }
  const amount = Number(text)
  return Number.isFinite(amount) ? amount : undefined
}

function formatPrice(value: unknown, currencyValue: unknown): string {
  const raw = scalar(value)
  const currency = scalar(currencyValue).toUpperCase()
  const amount = parseAmount(value)
  if (!raw) return ''
  if (currency === 'TRY' || currency === 'TL') {
    if (amount === undefined) return `${raw} TL`
    return `${new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(amount)} TL`
  }
  return `${raw}${currency ? ` ${currency}` : ''}`
}

function priceFromText(value: string): string {
  const match = clean(value).match(/(?:₺\s*)?(\d[\d.,]*)\s*(TL|TRY|₺)/i)
  return match ? formatPrice(match[1], 'TRY') : ''
}

function extractBasketDiscount(root: ParentNode): {
  price?: string
  text?: string
  source?: string
} {
  for (const element of root.querySelectorAll<HTMLElement>('.discount-price')) {
    const text = textOf(element)
    const price = priceFromText(text)
    if (text && price) {
      return { price, text: compact(text, 240), source: 'visible DOM .discount-price' }
    }
  }
  return {}
}

function extractPromotions(root: ParentNode): string[] {
  const selectors = ['.discount-price', '[class*="promotion" i]', '[class*="campaign" i]', '[class*="kampanya" i]']
  return unique(selectors.flatMap((selector) =>
    Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(isVisible).map(textOf),
  ).filter((value) => value.length >= 4 && value.length <= 300), 8)
}

function namedValue(value: unknown): string {
  return scalar(value) || scalar(object(value)?.name)
}

function extractImages(value: unknown): string[] {
  const images = Array.isArray(value) ? value : value ? [value] : []
  return unique(images.flatMap((image) => {
    if (typeof image === 'string') return [image]
    const item = object(image)
    return item ? [scalar(item.contentUrl), scalar(item.url)].filter(Boolean) : []
  }), 12)
}

function visibleProductImage(root: HTMLElement): string {
  const selectors = [
    '[itemprop="image"]',
    '[data-testid*="product-image"] img',
    '[class*="product-image" i] img',
    '[class*="product-gallery" i] img',
    'img[itemprop="image"]',
    'img',
  ]
  for (const selector of selectors) {
    for (const image of root.querySelectorAll<HTMLImageElement>(selector)) {
      if (!isVisible(image)) continue
      const rect = image.getBoundingClientRect()
      if (rect.width < 48 || rect.height < 48) continue
      const source = clean(image.currentSrc || image.src || image.getAttribute('src'))
      if (source && !source.startsWith('data:image/svg')) return source
    }
  }
  return ''
}

function jsonLdPropertyValue(raw: unknown): string {
  if (Array.isArray(raw)) {
    return unique(raw.map(jsonLdPropertyValue).filter(Boolean)).join(', ')
  }
  const obj = object(raw)
  if (!obj) return scalar(raw)
  const quant = [scalar(obj.value), scalar(obj.unitText || obj.unitCode)].filter(Boolean).join(' ')
  return namedValue(raw) || quant
}

function jsonLdSpecs(product: JsonObject): Record<string, string> {
  const specs: Record<string, string> = {}
  const addSpec = (key: string, value: string): void => {
    const cleanKey = compact(clean(key), 60)
    const cleanValue = compact(clean(value), 220)
    if (!cleanKey || !cleanValue) return
    const exists = Object.keys(specs).some(
      (existing) => existing.toLocaleLowerCase('tr-TR') === cleanKey.toLocaleLowerCase('tr-TR'),
    )
    if (!exists) specs[cleanKey] = cleanValue
  }

  for (const prop of objects(product.additionalProperty)) {
    const key = scalar(prop.name)
    const value = scalar(prop.value) || scalar(prop.unitText)
    addSpec(key, value)
  }

  const topLevelFields: Array<[string, string]> = [
    ['color', 'Color'],
    ['material', 'Material'],
    ['size', 'Size'],
    ['weight', 'Weight'],
    ['width', 'Width'],
    ['height', 'Height'],
    ['depth', 'Depth'],
    ['author', 'Author'],
    ['publisher', 'Publisher'],
    ['numberOfPages', 'Pages'],
    ['bookFormat', 'Format'],
    ['inLanguage', 'Language'],
    ['warranty', 'Warranty'],
    ['countryOfOrigin', 'Origin'],
    ['itemCondition', 'Condition'],
  ]
  for (const [field, label] of topLevelFields) {
    let val = jsonLdPropertyValue(product[field])
    if (field === 'itemCondition' && /^https?:\/\/schema\.org\//i.test(val)) {
      val = val.replace(/^https?:\/\/schema\.org\//i, '').replace(/Condition$/i, '')
    }
    addSpec(label, val)
  }

  return specs
}

const EXCLUDED_CONTAINER_SELECTOR =
  'script,style,noscript,svg,canvas,template,nav,header,footer,[data-pdp-assistant],[data-pdp-assistant-ignore],[class*="recommend" i],[class*="similar" i],[class*="related" i],[class*="carousel" i],[class*="breadcrumb" i],[class*="menu" i]'

const COLLAPSED_SPEC_CONTAINER_SELECTOR =
  '[class*="product-info" i],[class*="dimension" i],[class*="measure" i],[class*="spec" i],[class*="attribute" i],[class*="property" i],[class*="ozellik" i],[class*="tab" i],[class*="accordion" i],[class*="collapse" i],[role="tabpanel"],#productDetails_techSpec_section_1,#productDetails_detailBullets_sections1,#detailBullets_feature_div'

const SPEC_JUNK_LINE =
  /^(?:mağazalar|mağaza\s+adı|il\s*·\s*stok\s*adedi|stok\s*adedi|giriş yap|üye ol|sepete ekle|favorilerim|daha fazla bilgi|ilgili kategoriler|kvkk|gizlilik|teslimat ve iade|ödeme seçenekleri|taksit(?:\s*seçenekleri)?|taksit\s*tutarı(?:\s*·\s*toplam\s*tutar)?|toplam\s*tutar)$/i

function isInsideExcludedContainer(element: Element): boolean {
  return Boolean(element.closest(EXCLUDED_CONTAINER_SELECTOR))
}

function isExtractableSpecElement(element: HTMLElement, allowCollapsedPanels: boolean): boolean {
  if (isInsideExcludedContainer(element)) return false
  if (isVisible(element)) return true
  return allowCollapsedPanels && Boolean(element.closest(COLLAPSED_SPEC_CONTAINER_SELECTOR))
}

function specText(element: HTMLElement | null, allowCollapsedPanels: boolean): string {
  if (!element) return ''
  if (isVisible(element)) return clean(element.innerText || element.textContent)
  if (allowCollapsedPanels && element.closest(COLLAPSED_SPEC_CONTAINER_SELECTOR) && !isInsideExcludedContainer(element)) {
    return clean(element.textContent)
  }
  return ''
}

function domSpecs(root: ParentNode, allowCollapsedPanels = true): Record<string, string> {
  const specs: Record<string, string> = {}
  const add = (labelValue: string, detailValue: string): void => {
    const key = clean(labelValue).replace(/\s*:\s*$/, '')
    const value = compact(clean(detailValue), 200)
    if (
      !key ||
      !value ||
      key.length < 2 ||
      key.length > 48 ||
      key.split(/\s+/).length > 6 ||
      /[!?]|\.\s*$/.test(key) ||
      /^\d+(?:[-–/]\d+)?$/.test(key) ||
      key === value ||
      SPEC_JUNK_LINE.test(key) ||
      SPEC_JUNK_LINE.test(value) ||
      key in specs
    ) {
      return
    }
    specs[key] = value
  }
  for (const row of root.querySelectorAll<HTMLElement>('table tr')) {
    if (!isExtractableSpecElement(row, allowCollapsedPanels)) continue
    const cells = Array.from(row.querySelectorAll<HTMLElement>(':scope > th, :scope > td'))
      .map((cell) => specText(cell, allowCollapsedPanels))
      .filter(Boolean)
    if (cells.length >= 2) add(cells[0], cells.slice(1).join(' · '))
  }
  for (const term of root.querySelectorAll<HTMLElement>('dl dt')) {
    if (!isExtractableSpecElement(term, allowCollapsedPanels)) continue
    const detail = term.nextElementSibling
    if (detail instanceof HTMLElement && detail.matches('dd')) {
      add(specText(term, allowCollapsedPanels), specText(detail, allowCollapsedPanels))
    }
  }
  for (const item of root.querySelectorAll<HTMLElement>(
    '[class*="spec" i] li,[data-testid*="spec"] li,[class*="detail" i] li,[class*="attribute" i] li,[class*="property" i] li,[class*="attr" i] li,[class*="ozellik" i] li,#detailBullets_feature_div li,[class*="attribute" i] [class*="item" i],[class*="attr" i] [class*="item" i],[class*="attributeBox" i],[class*="spec" i] [class*="item" i],[class*="spec" i] [class*="row" i],[class*="property" i] [class*="item" i],[class*="ozellik" i] [class*="item" i],[class*="dimension" i] p,[class*="measure" i] p,[class*="product-information" i] p',
  )) {
    if (!isExtractableSpecElement(item, allowCollapsedPanels)) continue
    const children = Array.from(item.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement)
      .map((child) => specText(child, allowCollapsedPanels))
      .filter(Boolean)
    if (children.length >= 2 && children.length <= 4) {
      add(children[0], children.slice(1).join(' · '))
    } else {
      const text = specText(item, allowCollapsedPanels)
      const match = text.match(/^([^:]{2,48}):\s*(.+)$/)
      if (match) add(match[1], match[2])
    }
  }
  return specs
}

function textFromDescriptionContainer(container: HTMLElement): string {
  const content = container.querySelector<HTMLElement>('.collapse-inner') || container
  const blocks = Array.from(content.querySelectorAll<HTMLElement>('p,li'))
    .map((item) => clean(item.textContent))
    .filter(Boolean)
  return blocks.length ? unique(blocks).join('\n') : clean(content.textContent)
}

function isDescriptionLabel(value: string): boolean {
  const label = value.toLocaleLowerCase('tr-TR')
  return label.includes('ürün açıklaması') || label === 'açıklama' || label.includes('product description')
}

export function extractProductDescriptionSection(scope: ParentNode = document): string | undefined {
  const candidates: string[] = []
  const triggers = scope.querySelectorAll<HTMLElement>('a[href*="#"],button,[aria-controls],h2,h3,h4,h5,[role="tab"]')
  for (const trigger of triggers) {
    if (trigger.closest('[data-pdp-assistant],[data-pdp-assistant-ignore]')) continue
    if (!isDescriptionLabel(clean(trigger.textContent))) continue
    const href = trigger.getAttribute('href')
    const targetId = trigger.getAttribute('aria-controls')
      || trigger.getAttribute('data-target')?.replace(/^#/, '')
      || (href?.includes('#') ? href.split('#').pop() : undefined)
    const target = targetId ? document.getElementById(targetId) : null
    if (target && !target.closest('[data-pdp-assistant],[data-pdp-assistant-ignore]')) candidates.push(textFromDescriptionContainer(target))

    const sibling = trigger.nextElementSibling
    if (sibling instanceof HTMLElement && !sibling.closest('[data-pdp-assistant],[data-pdp-assistant-ignore]')) candidates.push(textFromDescriptionContainer(sibling))
    const parentContent = trigger.parentElement?.querySelector<HTMLElement>('.collapse-inner,[class*="description" i]')
    if (parentContent && parentContent !== trigger && !parentContent.closest('[data-pdp-assistant],[data-pdp-assistant-ignore]')) candidates.push(textFromDescriptionContainer(parentContent))
  }

  for (const selector of ['[itemprop="description"]', '[data-testid*="description"]', '[class*="product-description" i]']) {
    for (const element of scope.querySelectorAll<HTMLElement>(selector)) {
      if (element.closest('[data-pdp-assistant],[data-pdp-assistant-ignore]')) continue
      candidates.push(textFromDescriptionContainer(element))
    }
  }
  const best = candidates.map(clean).filter((value) => value.length >= 20).sort((a, b) => b.length - a.length)[0]
  return best ? compact(best, 6_000) : undefined
}

type ParsedDescription = {
  descriptionSpecs: Record<string, string>
  dimensionDetails: NonNullable<ProductContext['dimensionDetails']>
  materialsAndBuild: NonNullable<ProductContext['materialsAndBuild']>
  comfortAndBuildFacts: string[]
  partsInfo: NonNullable<ProductContext['partsInfo']>
}

function normalizeDimensionValue(value: string): string {
  return clean(value).replace(/(\d)\s*[x*]\s*(\d)/gi, '$1×$2')
}

export function parseSpecsFromDescription(descriptionText: string): ParsedDescription {
  const descriptionSpecs: Record<string, string> = {}
  const dimensionDetails: ParsedDescription['dimensionDetails'] = {}
  const materialsAndBuild: ParsedDescription['materialsAndBuild'] = {}
  const comfortAndBuildFacts: string[] = []
  const partsInfo: ParsedDescription['partsInfo'] = {}
  const addFact = (value: string | undefined): void => {
    const fact = clean(value)
    if (fact && !comfortAndBuildFacts.some((item) => item.toLocaleLowerCase('tr-TR') === fact.toLocaleLowerCase('tr-TR'))) {
      comfortAndBuildFacts.push(fact)
    }
  }

  const dimensionPatterns: Array<{ label: string; pattern: RegExp; field: keyof ParsedDescription['dimensionDetails'] }> = [
    { label: 'Oturum yükseklik', pattern: /oturum\s+yüksekli[kğ]i?\s*:\s*([^\n.!?]+)/i, field: 'sittingHeight' },
    { label: 'Ayak Yüksekliği', pattern: /ayak\s+yüksekliği\s*:\s*([^\n.!?]+)/i, field: 'legHeight' },
    { label: 'Oturum ölçüsü', pattern: /oturum\s+ölçüsü\s*:\s*([^\n.!?]+)/i, field: 'seatSize' },
    { label: 'Sırt ölçüsü', pattern: /sırt\s+ölçüsü\s*:\s*([^\n.!?]+)/i, field: 'backSize' },
    { label: 'Yatak ölçüsü', pattern: /yatak\s+ölçüsü\s*:\s*([^\n.!?]+)/i, field: 'bedSize' },
  ]
  for (const { label, pattern, field } of dimensionPatterns) {
    const match = descriptionText.match(pattern)
    if (!match) continue
    const value = normalizeDimensionValue(match[1])
    descriptionSpecs[label] = value
    dimensionDetails[field] = value
  }

  for (const line of descriptionText.split(/\n+/)) {
    const match = clean(line).match(/^([^:]{2,60}):\s*(.+)$/)
    if (!match) continue
    const key = clean(match[1])
    const value = normalizeDimensionValue(match[2])
    if (!(key in descriptionSpecs)) descriptionSpecs[key] = value
  }

  const metalProfile = descriptionText.match(/\d+[,.]\d+\s*mm[^.!?\n]{0,35}metal\s+profil/i)?.[0]
  const mdfBase = descriptionText.match(/\d+[,.]\d+\s*mm[^.!?\n]{0,35}mdf/i)?.[0]
  const fabric = descriptionText.match(/1\.\s*sınıf[^.!?\n]{0,35}kumaş/i)?.[0]
  const spring = descriptionText.match(/herkül\s+yay/i)?.[0]
  const blocks = descriptionText.match(/\d+\s*adet\s+sert\s+takoz/i)?.[0]
  const sermeSponge = descriptionText.match(/\d+[,.]\d+\s*cm\s+serme\s+sünger/i)?.[0]
  const weavingSponge = descriptionText.match(/\d+[,.]\d+\s*cm\s+dokuma\s+sünger(?:i)?/i)?.[0]
  const armFrame = descriptionText.match(/\d+\s*mm\s+sunta[^.!?\n]{0,20}(?:kol\s+iskeleti)?/i)?.[0]
  const legs = descriptionText.match(/\d+\s*adet\s+plastik\s+ayak/i)?.[0]
  const supportLegs = descriptionText.match(/\d+\s*adet\s+gizli\s+ayak(?:\s*\([^)]*\))?/i)?.[0]

  if (/metal\s+kasal[ıi]/i.test(descriptionText)) materialsAndBuild.frame = 'Metal kasa'
  if (metalProfile) materialsAndBuild.frame = [materialsAndBuild.frame, clean(metalProfile)].filter(Boolean).join(' · ')
  if (fabric) materialsAndBuild.fabric = clean(fabric)
  if (mdfBase) materialsAndBuild.base = `${clean(mdfBase)} taban`
  if (spring || blocks) materialsAndBuild.spring = [clean(spring), clean(blocks)].filter(Boolean).join(' · ')
  if (sermeSponge || weavingSponge) materialsAndBuild.sponge = [clean(sermeSponge), clean(weavingSponge)].filter(Boolean).join(' · ')
  if (legs) materialsAndBuild.legs = clean(legs)
  if (supportLegs) materialsAndBuild.supportLegs = clean(supportLegs)

  if (legs) partsInfo.plasticLegs = clean(legs)
  if (supportLegs) {
    const count = clean(supportLegs).match(/^\d+/)?.[0]
    partsInfo.hiddenSupportLegs = count ? `${count} adet gizli destek ayağı` : clean(supportLegs)
  }
  if (/metal\s+kasal[ıi]/i.test(descriptionText) || metalProfile) {
    partsInfo.frame = ['metal kasa', metalProfile ? clean(metalProfile) : ''].filter(Boolean).join(' · ')
  }
  if (mdfBase) partsInfo.base = clean(mdfBase)
  if (spring) partsInfo.spring = clean(spring)
  if (blocks) partsInfo.supportBlocks = clean(blocks)
  if (armFrame) partsInfo.armFrame = clean(armFrame)
  const exactPieceCount = descriptionText.match(/(?:paket(?:in)?\s*(?:içeriği)?|ürün)\s*(?:toplam\s*)?(\d+\s*(?:adet\s*)?parça(?:dan)?)/i)?.[1]
    || descriptionText.match(/toplam\s+(\d+\s*(?:adet\s*)?parça)/i)?.[1]
  if (exactPieceCount) partsInfo.exactPackagePieceCount = clean(exactPieceCount)
  partsInfo.knownParts = unique([
    partsInfo.plasticLegs,
    partsInfo.hiddenSupportLegs,
    partsInfo.frame,
    partsInfo.base,
    partsInfo.spring,
    partsInfo.supportBlocks,
    partsInfo.armFrame,
  ].filter((value): value is string => Boolean(value)), 12)

  addFact(materialsAndBuild.frame)
  addFact(materialsAndBuild.fabric)
  addFact(materialsAndBuild.base)
  addFact(materialsAndBuild.spring)
  addFact(materialsAndBuild.sponge)
  addFact(armFrame ? `${clean(armFrame)} kol iskeleti` : undefined)
  addFact(materialsAndBuild.legs)
  addFact(materialsAndBuild.supportLegs)
  return { descriptionSpecs, dimensionDetails, materialsAndBuild, comfortAndBuildFacts, partsInfo }
}

function extractFeatures(root: HTMLElement, specs?: Record<string, string>): string[] {
  const selectors = ['[data-feature-name="featurebullets"] li', '[data-testid*="feature"] li', '[class*="feature" i] li', '[class*="highlight" i] li']
  const primary = selectors.flatMap((selector) =>
    Array.from(root.querySelectorAll<HTMLElement>(selector))
      .filter((el) => !isInsideExcludedContainer(el))
      .map(textOf),
  ).filter((value) => value.length >= 4 && value.length <= 300)

  const specSet = new Set(Object.values(specs || {}).map((v) => v.toLocaleLowerCase()))
  const secondary = Array.from(
    root.querySelectorAll<HTMLElement>('[class*="product-detail" i] ul li,[class*="product-info" i] ul li,[class*="description" i] ul li'),
  )
    .filter((el) => {
      if (isInsideExcludedContainer(el)) return false
      if (el.closest('[class*="size-list" i],[class*="size-select" i],[class*="color-list" i],[class*="attribute" i]')) {
        return false
      }
      return isVisible(el)
    })
    .map(textOf)
    .filter((value) => value.length >= 10 && value.length <= 220 && !specSet.has(value.toLocaleLowerCase()))

  return unique([...primary, ...secondary], MAX_FEATURES)
}

const LETTER_SIZE_PATTERN =
  /^(?:4XS|3XS|2XS|XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|6XL|STD|STANDART|TEK BEDEN|ONE SIZE|FREE SIZE|XS\/S|S\/M|M\/L|L\/XL|XL\/XXL)$/i
const NUMERIC_SIZE_PATTERN =
  /^(\d{2})(?:[.,]5)?(?:\s*[-/]\s*(\d{2})(?:[.,]5)?)?(?:\s*(?:EU|US|UK|TR|CM|NUMARA|BEDEN))?$/i
const KIDS_SIZE_PATTERN =
  /^\d{1,2}\s*[-–]\s*\d{1,2}\s*(?:ay|yaş|yas|months?|years?|y|m)$/i

function isValidSizeLabel(label: string): boolean {
  const cleaned = clean(label)
  if (!cleaned || cleaned.length > 20) return false
  if (LETTER_SIZE_PATTERN.test(cleaned)) return true
  if (KIDS_SIZE_PATTERN.test(cleaned)) return true
  const numMatch = cleaned.match(NUMERIC_SIZE_PATTERN)
  if (!numMatch) return false
  const first = Number(numMatch[1])
  return first >= 16 && first <= 64
}

const OUT_OF_STOCK_CLASS_RE = /out-?of-?stock|sold-?out|disabled|unavailable|no-?stock|tuken|passive|stok.*yok/i
const OUT_OF_STOCK_TEXT_RE = /\b(?:stoğa\s+gelince|stoga\s+gelince|tükendi|tukendi|stokta\s+yok|out\s+of\s+stock|sold\s+out|notify\s+me|haber\s+ver)\b/i
const STRIP_SIZE_SUFFIX_RE = /\s*[-–—|]?\s*(?:stoğa\s+gelince\s+haber\s+ver|stoga\s+gelince\s+haber\s+ver|tükendi|tukendi|stokta\s+yok|out\s+of\s+stock|sold\s+out|haber\s+ver|notify\s+me).*$/i

function extractSizeOptions(
  root: HTMLElement,
  product: JsonObject | undefined,
): {
  sizes: string[]
  inStockSizes: string[]
  outOfStockSizes: string[]
  selectedSize?: string
} {
  const entries = new Map<string, { label: string; status: 'in' | 'out' | 'unknown' }>()
  let selectedSize: string | undefined

  const record = (rawLabel: string, status: 'in' | 'out' | 'unknown', selected = false): void => {
    const cleaned = clean(rawLabel.replace(STRIP_SIZE_SUFFIX_RE, ''))
    if (!isValidSizeLabel(cleaned)) return
    const key = cleaned.toLocaleUpperCase()
    const existing = entries.get(key)
    if (!existing) {
      entries.set(key, { label: cleaned, status })
    } else if (status === 'out' || (existing.status === 'unknown' && status === 'in')) {
      existing.status = status
    }
    if (selected && !selectedSize) selectedSize = cleaned
  }

  // 1. JSON-LD size & variant stock
  if (product) {
    const rawSizes = Array.isArray(product.size)
      ? product.size.map((item) => scalar(item) || namedValue(item))
      : scalar(product.size)
        ? scalar(product.size).split(/[,|]/)
        : []
    for (const s of rawSizes) record(s, 'unknown')

    for (const variant of objects(product.hasVariant)) {
      const sizeVal = scalar(variant.size) || namedValue(variant.size)
      if (!sizeVal) continue
      const offer = firstObject(variant.offers)
      const avail = normalizeAvailability(offer?.availability).toLowerCase()
      const status = avail.includes('outofstock') || avail.includes('soldout')
        ? 'out'
        : avail.includes('instock')
          ? 'in'
          : 'unknown'
      record(sizeVal, status)
    }
  }

  // 2. Semantic DOM size containers (avoiding Tailwind size-0 / size-4 utilities)
  const SIZE_PICKER_SELECTOR =
    '[class*="size-list" i],[class*="size-select" i],[class*="size-box" i],[class*="size-picker" i],[class*="size-option" i],[class*="size-selector" i],[class*="sizes" i],[class*="beden" i],[data-testid*="size" i],[data-testid*="beden" i],[aria-label*="beden" i],[aria-label*="size" i],[id*="size-list" i],[id*="beden" i]'

  const scanSizeContainers = (scope: ParentNode): void => {
    for (const container of scope.querySelectorAll<HTMLElement>(SIZE_PICKER_SELECTOR)) {
      if (isInsideExcludedContainer(container)) continue
      if (container.matches('select')) continue
      const items = container.querySelectorAll<HTMLElement>(
        'button,[role="radio"],[role="option"],label,a,li,[class*="size-item" i],[class*="size-li" i],[class*="size-btn" i],[class*="beden-item" i]',
      )
      for (const item of items) {
        if (isInsideExcludedContainer(item)) continue
        if (item.matches('li') && item.querySelector('button,label,a,[role="radio"],[role="option"]')) continue
        const rawText = clean(item.textContent)
        if (!rawText || rawText.length > 60) continue
        const isDisabled =
          item.matches(':disabled') ||
          item.hasAttribute('disabled') ||
          item.getAttribute('aria-disabled') === 'true' ||
          OUT_OF_STOCK_CLASS_RE.test(String(item.className || '')) ||
          OUT_OF_STOCK_TEXT_RE.test(rawText) ||
          Boolean(
            item.querySelector(
              'input[disabled],[disabled],[aria-disabled="true"],[class*="out-of-stock" i],[class*="disabled" i],[class*="sold-out" i]',
            ),
          )
        const checkedInput = item.querySelector<HTMLInputElement>('input[type="radio"]:checked')
        const isSelected =
          item.getAttribute('aria-checked') === 'true' ||
          item.getAttribute('aria-pressed') === 'true' ||
          item.getAttribute('aria-selected') === 'true' ||
          /\b(?:selected|active)\b/i.test(String(item.className || '')) ||
          Boolean(checkedInput)
        record(rawText, isDisabled ? 'out' : 'in', isSelected)
      }
    }

    for (const select of scope.querySelectorAll<HTMLSelectElement>('select')) {
      if (isInsideExcludedContainer(select)) continue
      const meta = `${select.name} ${select.id} ${select.className} ${select.getAttribute('aria-label') || ''} ${select.options[0]?.text || ''}`
      if (!/beden|size|numara/i.test(meta)) continue
      if (/quantity|adet|city|il\b|ulke|country|sort|siralama/i.test(meta)) continue
      for (const opt of Array.from(select.options)) {
        const rawText = clean(opt.textContent)
        if (!rawText) continue
        const isDisabled = opt.disabled || OUT_OF_STOCK_TEXT_RE.test(rawText)
        record(rawText, isDisabled ? 'out' : 'in', opt.selected && isValidSizeLabel(rawText.replace(STRIP_SIZE_SUFFIX_RE, '')))
      }
    }
  }

  scanSizeContainers(root)
  if (!entries.size && root !== document.body) {
    scanSizeContainers(document.body)
  }

  const all = Array.from(entries.values())
  return {
    sizes: all.map((e) => e.label),
    inStockSizes: all.filter((e) => e.status === 'in').map((e) => e.label),
    outOfStockSizes: all.filter((e) => e.status === 'out').map((e) => e.label),
    selectedSize,
  }
}

function cleanColorLabel(raw: string): string {
  return clean(
    raw
      .replace(/\d[\d.,]*\s*(?:TL|TRY|₺|\$|€|£)/gi, ' ')
      .replace(/\b(?:sepete\s+ekle|add\s+to\s+(?:cart|bag)|renk|color|colour|seçiniz|seciniz)\b/gi, ' '),
  )
}

function extractColorOptions(
  root: HTMLElement,
  product: JsonObject | undefined,
  specs: Record<string, string>,
): string[] {
  const candidates: string[] = []

  const pushColor = (raw: string): void => {
    const label = cleanColorLabel(raw)
    if (label.length >= 2 && label.length <= 40 && !/^\d+$/.test(label)) {
      candidates.push(label)
    }
  }

  for (const [k, v] of Object.entries(specs)) {
    if (/^(?:renk|color|colour|renk\s+grubu)$/i.test(clean(k))) {
      for (const part of v.split(/[,/]/)) pushColor(part)
    }
  }

  if (product) {
    const rawColors = Array.isArray(product.color)
      ? product.color.map((item) => scalar(item) || namedValue(item))
      : scalar(product.color)
        ? scalar(product.color).split(/[,/]/)
        : []
    for (const c of rawColors) pushColor(c)
    for (const variant of objects(product.hasVariant)) {
      const c = scalar(variant.color) || namedValue(variant.color)
      if (c) pushColor(c)
    }
  }

  const scanColorSelectors = (scope: ParentNode): void => {
    const selectors = [
      '[class*="product-color-name" i]',
      '[data-testid*="selected-color" i]',
      '[class*="color-list" i] a',
      '[class*="color-list" i] button',
      '[class*="color-list" i] li',
      '[class*="color-swatch" i]',
      '[class*="color-option" i]',
      '[class*="product-color-modal" i] a',
      '[class*="product-color-modal" i] li',
      '[class*="product-color-modal" i] [class*="item" i]',
      '[data-testid*="color-option" i]',
      '[data-color]',
    ]
    for (const selector of selectors) {
      for (const el of scope.querySelectorAll<HTMLElement>(selector)) {
        if (isInsideExcludedContainer(el)) continue
        const dataColor = el.getAttribute('data-color')
        if (dataColor) {
          pushColor(dataColor)
          continue
        }
        const imgAlt = el.querySelector<HTMLImageElement>('img')?.alt
        const txt = clean(el.textContent) || clean(el.getAttribute('aria-label')) || clean(el.getAttribute('title')) || clean(imgAlt)
        if (txt) pushColor(txt)
      }
    }
  }

  scanColorSelectors(root)
  if (root !== document.body) {
    scanColorSelectors(document.body)
  }

  return unique(candidates, 16)
}

function extractModelMeasurements(root: HTMLElement, descriptionText: string): string[] {
  const MODEL_RE = /\b(?:manken\w*|modelin\s+üzerindeki|model\s+(?:is|wears|wearing|boy|ölçü|olcu)|mannequin)\b/i
  const results: string[] = []

  for (const line of descriptionText.split(/[\n.]+/)) {
    const trimmed = clean(line)
    if (trimmed.length >= 12 && trimmed.length <= 240 && MODEL_RE.test(trimmed)) {
      results.push(trimmed)
    }
  }

  const scanDom = (scope: ParentNode): void => {
    for (const el of scope.querySelectorAll<HTMLElement>('p,li,div,span')) {
      if (el.children.length > 2 || isInsideExcludedContainer(el)) continue
      const trimmed = clean(el.textContent)
      if (trimmed.length >= 12 && trimmed.length <= 240 && MODEL_RE.test(trimmed)) {
        results.push(trimmed)
      }
    }
  }
  scanDom(root)
  if (!results.length && root !== document.body) scanDom(document.body)

  return unique(results, 4)
}

function extractBreadcrumbs(): string[] {
  for (const selector of ['nav[aria-label*="breadcrumb" i]', '[itemtype*="BreadcrumbList"]', '[data-testid*="breadcrumb"]', '[class*="breadcrumb" i]']) {
    for (const container of document.querySelectorAll<HTMLElement>(selector)) {
      if (!isVisible(container)) continue
      const parts = unique(Array.from(container.querySelectorAll<HTMLElement>('a,li,[itemprop="name"]')).map(textOf)
        .filter((value) => value && !/^(home|ana sayfa|›|>|\/|-)$/i.test(value)), 8)
      if (parts.length) return parts
    }
  }
  return []
}

function fallbackVisiblePrice(root: HTMLElement): { price: string; currency: string } | undefined {
  const pattern = /(?:([$€£¥₺₹])\s*(\d[\d.,]*)|(\d[\d.,]*)\s*(TL|TRY|USD|EUR|GBP|CAD|AUD))/i
  const candidates: Array<{ amount: number; price: string; currency: string; score: number }> = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (!parent || !isVisible(parent)) continue
    const text = clean(node.textContent)
    const match = text.match(pattern)
    if (!match) continue
    const nearby = clean(parent.innerText || parent.textContent).slice(0, 500)
    if (PRICE_NOISE.test(nearby)) continue
    const rawAmount = match[2] || match[3]
    const amount = parseAmount(rawAmount)
    if (amount === undefined) continue
    const rawCurrency = match[1] || match[4] || ''
    const currency = /₺|TL|TRY/i.test(rawCurrency) ? 'TRY' : rawCurrency
    if (currency === 'TRY' && amount < 5) continue
    const score = (/fiyat|price|satış/i.test(nearby) ? 1_000_000 : 0) + amount
    candidates.push({ amount, price: rawAmount, currency, score })
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]
}

function getOffer(product: JsonObject): JsonObject | undefined {
  const direct = objects(product.offers)
  const variant = firstObject(product.hasVariant)
  const offers = direct.length ? direct : variant ? objects(variant.offers) : []
  return offers.find((offer) =>
    Boolean(scalar(offer.price) || scalar(offer.lowPrice) || scalar(firstObject(offer.priceSpecification)?.price)),
  ) || offers[0]
}

function selectMainProduct(products: JsonObject[], root: HTMLElement): JsonObject | undefined {
  if (products.length <= 1) return products[0]
  const domTitle = clean(firstText(root, ['h1[itemprop="name"]', '[data-testid*="product-title"]', 'h1']))
    .toLocaleLowerCase('tr-TR')
  const canonicalUrl = clean(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || location.href)
  const visibleSku = clean(attributeOrText(root, ['[itemprop="sku"]', '[data-testid*="sku"]', '[class*="sku" i]']))
    .toLocaleLowerCase('tr-TR')

  return products
    .map((product, index) => {
      const name = scalar(product.name).toLocaleLowerCase('tr-TR')
      const url = scalar(product.url) || scalar(product['@id'])
      const sku = scalar(product.sku).toLocaleLowerCase('tr-TR')
      let resolvedUrl = ''
      try {
        resolvedUrl = url ? new URL(url, location.href).href.split('#')[0] : ''
      } catch {
        // Malformed structured-data URLs should not stop DOM extraction.
      }
      let score = getOffer(product) ? 5 : 0
      if (domTitle && name === domTitle) score += 100
      else if (domTitle && name && (domTitle.includes(name) || name.includes(domTitle))) score += 55
      if (resolvedUrl && canonicalUrl && resolvedUrl === canonicalUrl.split('#')[0]) score += 80
      if (visibleSku && sku && visibleSku.includes(sku)) score += 70
      return { product, score, index }
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.product
}

function shippingFee(offer: JsonObject | undefined): string {
  const detail = objects(offer?.shippingDetails)[0]
  const rate = firstObject(detail?.shippingRate)
  if (!rate) return scalar(detail?.shippingRate)
  return formatPrice(rate.value, rate.currency)
}

function returnDays(product: JsonObject, offer: JsonObject | undefined): number | undefined {
  const policy = firstObject(offer?.hasMerchantReturnPolicy) || firstObject(product.hasMerchantReturnPolicy)
  const rawDays = scalar(policy?.merchantReturnDays)
  if (!rawDays) return undefined
  const days = Number(rawDays)
  return Number.isFinite(days) ? days : undefined
}

function returnPolicyText(product: JsonObject, offer: JsonObject | undefined): string | undefined {
  const policy = firstObject(offer?.hasMerchantReturnPolicy) || firstObject(product.hasMerchantReturnPolicy)
  const text = scalar(policy?.description)
  return text ? compact(text, 360) : undefined
}

function parseRating(value: unknown): number | undefined {
  const rating = Number.parseFloat(scalar(value).replace(',', '.'))
  return Number.isFinite(rating) ? rating : undefined
}

function formatRating(value: unknown): string | undefined {
  const rating = parseRating(value)
  if (rating === undefined) return undefined
  return rating.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1')
}

function jsonLdReviews(product: JsonObject | undefined): ProductReview[] {
  if (!product) return []
  const reviews: ProductReview[] = []
  for (const review of objects(product.review)) {
    const body = compact(scalar(review.reviewBody), 500)
    if (!body) continue
    const reviewRating = firstObject(review.reviewRating)
    reviews.push({
      rating: parseRating(reviewRating?.ratingValue ?? review.ratingValue),
      body,
      date: scalar(review.datePublished) || undefined,
    })
  }
  return reviews
}

function visibleReviews(root: ParentNode): ProductReview[] {
  const reviews: ProductReview[] = []
  const selectors = ['[itemprop="review"]', '[data-testid*="review-item"]', '[class*="review-item" i]', '[class*="review-card" i]']
  const elements = selectors.flatMap((selector) => Array.from(root.querySelectorAll<HTMLElement>(selector)))
  const seen = new Set<string>()
  for (const element of elements) {
    if (!isVisible(element) || isInsideExcludedContainer(element)) continue
    const body = compact(firstText(element, ['[itemprop="reviewBody"]', '[class*="review-body" i]', '[class*="comment" i]', 'p']), 500)
    const key = body.toLocaleLowerCase()
    if (!body || seen.has(key)) continue
    seen.add(key)
    const ratingElement = element.querySelector<HTMLElement>('[itemprop="ratingValue"],[aria-label*="star" i],[aria-label*="yıldız" i],[class*="rating" i]')
    const ratingText = ratingElement
      ? ratingElement.getAttribute('content') || ratingElement.getAttribute('aria-label') || textOf(ratingElement)
      : ''
    const dateElement = element.querySelector<HTMLElement>('time,[itemprop="datePublished"],[class*="date" i]')
    reviews.push({
      rating: parseRating(ratingText),
      body,
      date: dateElement?.getAttribute('datetime') || textOf(dateElement) || undefined,
    })
  }
  return reviews
}

function mergeReviews(primary: ProductReview[], fallback: ProductReview[]): ProductReview[] {
  const result: ProductReview[] = []
  const seen = new Set<string>()
  for (const review of [...primary, ...fallback]) {
    const body = clean(review.body)
    const key = body.toLocaleLowerCase()
    if (!body || seen.has(key)) continue
    seen.add(key)
    result.push({ ...review, body })
    if (result.length >= 6) break
  }
  return result
}

function summarizeReviews(reviews: ProductReview[], averageRating?: string, reviewCount?: number): ReviewSummary {
  const snippets = (predicate: (rating: number) => boolean) => reviews
    .filter((review) => review.rating !== undefined && predicate(review.rating))
    .map((review) => compact(review.body, 180))
    .slice(0, 3)
  const mentions = (keywords: readonly string[]) => reviews
    .filter((review) => keywords.some((keyword) => review.body.toLocaleLowerCase('tr-TR').includes(keyword)))
    .map((review) => compact(review.body, 180))
    .slice(0, 3)
  const deliveryMentions = mentions(REVIEW_THEME_KEYWORDS.delivery)
  const packagingMentions = mentions(REVIEW_THEME_KEYWORDS.packaging)
  const usabilityMentions = mentions(REVIEW_THEME_KEYWORDS.usability)
  const assemblyMentions = mentions(REVIEW_THEME_KEYWORDS.assembly)
  const commonThemes = [
    deliveryMentions.length ? 'teslimat' : '',
    packagingMentions.length ? 'paketleme' : '',
    usabilityMentions.length ? 'kullanışlılık' : '',
    assemblyMentions.length ? 'montaj' : '',
  ].filter(Boolean)
  return {
    averageRating,
    reviewCount,
    positiveSnippets: snippets((rating) => rating >= 4),
    negativeSnippets: snippets((rating) => rating <= 3),
    commonThemes,
    deliveryMentions,
    packagingMentions,
    usabilityMentions,
    assemblyMentions,
  }
}

function extractVisibleQna(root: ParentNode): ProductQna[] {
  const result: ProductQna[] = []
  const seen = new Set<string>()
  const selectors = ['[itemtype*="schema.org/Question"]', '[data-testid*="question"]', '[class*="question-item" i]', '[class*="qna-item" i]']
  const elements = selectors.flatMap((selector) => Array.from(root.querySelectorAll<HTMLElement>(selector)))
  for (const element of elements) {
    if (!isVisible(element)) continue
    const question = compact(firstText(element, ['[itemprop="name"]', '[class*="question-title" i]', '[class*="question-text" i]', 'summary', 'h3', 'h4']), 300)
    const key = question.toLocaleLowerCase()
    if (!question || seen.has(key)) continue
    seen.add(key)
    const answer = compact(firstText(element, ['[itemprop="acceptedAnswer"] [itemprop="text"]', '[itemprop="suggestedAnswer"] [itemprop="text"]', '[class*="answer" i]']), 500)
    result.push({ question, answer: answer || undefined })
    if (result.length >= 10) break
  }
  return result
}

function normalizeKey(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

export function detectContextTurkish(context: ProductContext): boolean {
  if (typeof document !== 'undefined' && document.documentElement.lang.toLocaleLowerCase().startsWith('tr')) {
    return true
  }
  const sample = [
    context.title,
    context.listedPrice,
    context.basketPrice,
    context.description,
    ...Object.entries(context.specs || {}).flat(),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')

  return /[çğıöşüÇĞİÖŞÜ]|\bTL\b|₺|\b(?:fiyat|kalip|kumas|taban|yikama|garanti|kargo|renk|olcu|beden|ayakkabi|elbise|kanepe|yorum|urun|ozellik|stokta|sepette)\b/i.test(
    sample,
  )
}

export function getSuggestedQuestions(context: ProductContext): string[] {
  const MAX_SUGGESTED_QUESTIONS = 8
  const questions: string[] = []
  const specs = context.specs || {}
  const isTurkishPage = detectContextTurkish(context)
  const hasReviews = Boolean(context.reviews?.length || context.reviewCount)
  const maxBeforeReviews = hasReviews ? MAX_SUGGESTED_QUESTIONS - 1 : MAX_SUGGESTED_QUESTIONS
  const coveredSpecKeys = new Set<string>()
  const q = (turkish: string, english: string): string => (isTurkishPage ? turkish : english)

  const add = (question: string, limit = maxBeforeReviews): void => {
    if (!questions.includes(question) && questions.length < limit) {
      questions.push(question)
    }
  }

  const findSpecKey = (
    keyPatterns: RegExp[],
    valuePatterns?: RegExp[],
  ): string | undefined => {
    for (const [key, value] of Object.entries(specs)) {
      const normKey = normalizeKey(key)
      const normValue = normalizeKey(value)
      if (!keyPatterns.some((pattern) => pattern.test(normKey))) continue
      if (valuePatterns && !valuePatterns.some((pattern) => pattern.test(normValue))) continue
      coveredSpecKeys.add(key)
      return key
    }
    return undefined
  }

  const findSpecByKeyOrValue = (
    keyPatterns: RegExp[],
    valuePatterns: RegExp[],
  ): string | undefined => {
    for (const [key, value] of Object.entries(specs)) {
      const normKey = normalizeKey(key)
      const normValue = normalizeKey(value)
      if (
        keyPatterns.some((pattern) => pattern.test(normKey)) ||
        valuePatterns.some((pattern) => pattern.test(normValue))
      ) {
        coveredSpecKeys.add(key)
        return key
      }
    }
    return undefined
  }

  // 1. Price
  if (context.basketPrice) add(q('Sepette fiyatı ne kadar?', 'What is the basket price?'))
  else if (context.listedPrice || context.price) add(q('Fiyatı ne kadar?', 'What is the price?'))

  // 2. Sizes / Stock availability
  if (context.sizes?.length) {
    const isFootwear = /ayakkab|bot|sneaker|shoe|running/i.test(
      normalizeKey(`${context.title ?? ''} ${context.category ?? ''}`),
    )
    add(
      isFootwear
        ? q('Hangi numaralar stokta var?', 'What shoe sizes are available?')
        : q('Hangi bedenler stokta var?', 'What sizes are available?'),
    )
  }

  // 3. Fit / Kalıp
  if (findSpecKey([/\b(?:kalip|kalib|fit|kesim)\b/])) {
    add(q('Kalıbı nasıl?', 'How is the fit?'))
  }

  // 4. Material / Fabric
  const hasMaterialBuild =
    Object.values(context.materialsAndBuild || {}).some(Boolean) ||
    Boolean(context.comfortAndBuildFacts?.length)
  const materialKey = findSpecKey([
    /\b(?:malzeme\w*|materyal\w*|kumas\w*|urun\s*icerig\w*|icerik|material|fabric|ust\s*yuzey|upper)\b/,
  ])
  if (hasMaterialBuild || materialKey) {
    const isFabricSpec = Boolean(materialKey && /\bkumas/.test(normalizeKey(materialKey)))
    add(isTurkishPage && isFabricSpec ? 'Kumaşı nedir?' : q('Malzemesi nedir?', 'What is it made of?'))
  }

  // 4. Lining / Sheerness
  if (findSpecByKeyOrValue([/\b(?:astar|lining)\b/], [/\b(?:ic\s*goster|sheer|lining|astar)\b/])) {
    add(q('Astarı var mı, iç gösterir mi?', 'Is it lined or see-through?'))
  }

  // 5. Care / Washing
  if (findSpecKey([/\b(?:yikama|bakim|wash|care)\b/])) {
    add(q('Nasıl yıkanır?', 'How should it be washed?'))
  }

  // 6. Sole / Cushioning
  if (findSpecKey([/\b(?:taban|sole)\b/])) {
    add(q('Tabanı ve yastıklaması nasıl?', 'What is the sole like?'))
  }

  // 7. Bed dimensions (furniture sofabeds only)
  if (
    context.dimensionDetails?.bedSize ||
    findSpecKey([/yatak.*(?:olcu|boyut)/, /bed.*size/])
  ) {
    add(q('Yatak ölçüsü nedir?', 'What are the bed dimensions?'))
  }

  // 8. Dimensions or apparel length
  const dimSpecKey = findSpecKey([
    /\b(?:yukseklik|genislik|derinlik|uzunluk|olcu|ebat|boyut|height|width|depth|dimension)\b/,
  ])
  if (
    context.dimensionDetails?.height ||
    context.dimensionDetails?.width ||
    context.dimensionDetails?.depth ||
    dimSpecKey
  ) {
    add(q('Ölçüleri nedir?', 'What are the dimensions?'))
  } else if (findSpecKey([/^boy$/, /\b(?:elbise\s*boy|urun\s*boy|length)\b/])) {
    add(q('Boyu kaç cm?', 'What is the length?'))
  }

  // 9. Capacity (distinguish furniture seating vs bags/bottles/electronics)
  const capKey = findSpecKey([/\b(?:kapasite\w*|kisilik|oturma|capacity|hacim|volume)\b/])
  if (capKey) {
    const capCombined = normalizeKey(`${capKey} ${specs[capKey] ?? ''}`)
    const isSeating = /kisilik|oturma|person|seat/.test(capCombined)
    add(
      isSeating
        ? q('Bu ürün kaç kişilik?', 'What is the seating capacity?')
        : q('Kapasitesi ne kadar?', 'What is its capacity?'),
    )
  }

  // 10. Storage / Baza (furniture baza vs digital storage)
  const furnitureContext = /\b(?:kanepe|koltuk|yatak|baza|berjer|sofa|couch|bed|ottoman|furniture)\b/.test(
    normalizeKey(`${context.title ?? ''} ${context.category ?? ''} ${context.description ?? ''}`),
  )
  const bazaKey = findSpecByKeyOrValue(
    [/\b(?:baza|bazali)\b/],
    [/\b(?:baza|bazali)\b/],
  ) || findSpecKey([/\bstorage\b/], [/\b(?:under-?bed|sofa|drawer|baza|compartment)\b/])
  if (bazaKey || (furnitureContext && findSpecKey([/\b(?:baza|depolama|storage)\b/]))) {
    add(q('Bazalı mı?', 'Does it include storage?'))
  } else if (
    findSpecKey(
      [/\b(?:depolama|hafiza|dahili\s*hafiza|storage|ssd)\b/],
      [/\b(?:gb|tb|mb|ssd|nvme|hdd)\b/],
    )
  ) {
    add(q('Depolama kapasitesi ne kadar?', 'What is the storage capacity?'))
  }

  // 11. Common cross-category attributes
  if (findSpecKey([/\b(?:laptop|bilgisayar|notebook)\b/])) {
    add(q('Kaç inç laptop sığar?', 'What laptop size fits?'))
  }
  if (findSpecKey([/\b(?:ekran|display|screen)\b/])) {
    add(q('Ekran özellikleri nedir?', 'What are the display specs?'))
  }
  if (findSpecKey([/\b(?:batarya|pil|battery)\b/])) {
    add(q('Batarya özellikleri nasıl?', 'How is the battery life?'))
  }
  if (findSpecKey([/\b(?:agirlik|weight)\b/])) {
    add(q('Ağırlığı ne kadar?', 'How heavy is it?'))
  }
  const colorSpecKey = findSpecKey([/\b(?:renk|colou?r)\b/])
  if ((context.colors?.length ?? 0) >= 2) {
    add(q('Hangi renkleri var?', 'What colors are available?'))
  } else if (colorSpecKey || context.colors?.length) {
    add(q('Rengi nedir?', 'What color is it?'))
  }
  if (findSpecKey([/\b(?:garanti\w*|warranty)\b/])) {
    add(q('Garanti süresi nedir?', 'What is the warranty?'))
  }

  // 12. Assembly & parts (strictly gated — never triggered by unrelated shoe/apparel words)
  if (
    context.assemblyInfo?.requiresAssembly !== undefined ||
    Boolean(context.assemblyInfo?.assemblyEvidence?.length) ||
    Boolean(findSpecKey([/\b(?:kurulum|montaj|demonte|assembly)\b/]))
  ) {
    add(q('Kurulumu zor mu?', 'Does it require assembly?'))
  }

  if (
    Boolean(context.partsInfo?.exactPackagePieceCount) ||
    (context.partsInfo?.knownParts?.length ?? 0) >= 2 ||
    Boolean(findSpecKey([/\b(?:paket\s*icerig|kutu\s*icerig|in\s*the\s*box|package\s*contents)\b/]))
  ) {
    add(q('Paket içeriğinde neler var?', 'What is included in the box?'))
  }

  // 13. Dynamic spec questions for any remaining attributes on arbitrary websites
  const NOISY_SPEC_KEY = /\b(?:sku|barkod|barcode|gtin|ean|mpn|isbn|kod|code|id|model\s*no|urun\s*kodu|stok\s*kodu|upc|asin|price|fiyat|liste\s*fiyat|tax|kdv|vergi|taksit|odeme|magaza\s*ad|olcu\s*tanim|stok\s*aded|number\s*of\s*reviews|yorum\s*sayis|availability|stok\s*durum|product\s*type|urun\s*tipi|magazalar|ilgili\s*kategoriler)\b/i
  for (const [key, rawValue] of Object.entries(specs)) {
    if (questions.length >= Math.min(5, maxBeforeReviews)) break
    if (coveredSpecKeys.has(key)) continue
    const cleanKey = clean(key)
    if (!clean(rawValue) || cleanKey.length < 3 || cleanKey.length > 26) continue
    if (NOISY_SPEC_KEY.test(normalizeKey(cleanKey))) continue
    coveredSpecKeys.add(cleanKey)
    add(isTurkishPage ? `${cleanKey} nedir?` : `What is the ${cleanKey.toLocaleLowerCase()}?`)
  }

  // 14. Return / Shipping when room remains
  if (questions.length < Math.min(6, maxBeforeReviews)) {
    if (context.returnDays || context.returnPolicyText) {
      add(q('İade süresi kaç gün?', 'What is the return policy?'))
    } else if (context.shippingFee || /kargo|teslim|ship/i.test(context.availability || '')) {
      add(q('Kargo ve teslimat nasıl?', 'How fast does it ship?'))
    }
  }

  // 15. Reviews (guaranteed slot when reviews exist)
  if (hasReviews) {
    add(q('Yorumlar nasıl?', 'How are the reviews?'), MAX_SUGGESTED_QUESTIONS)
  }

  // 16. Summary
  if (questions.length < MAX_SUGGESTED_QUESTIONS) {
    add(
      q('Satın almadan önce neye dikkat etmeliyim?', 'What should I know before buying?'),
      MAX_SUGGESTED_QUESTIONS,
    )
  }

  return questions.slice(0, MAX_SUGGESTED_QUESTIONS)
}

export function extractProductContext(): ProductContext {
  const root = findProductRoot()
  const chunks = visibleTextChunks(root)
  const products = parseJsonLdProducts()
  const product = selectMainProduct(products, root)
  const offer = product ? getOffer(product) : undefined
  const dataSource: string[] = []
  if (product) dataSource.push('json-ld product')

  const jsonPrice =
    scalar(offer?.price) ||
    scalar(offer?.lowPrice) ||
    scalar(firstObject(offer?.priceSpecification)?.price) ||
    scalar(offer?.highPrice)
  const jsonCurrency = scalar(offer?.priceCurrency) || scalar(firstObject(offer?.priceSpecification)?.priceCurrency)
  let listedCurrency = jsonCurrency
  let listedPrice = jsonPrice ? formatPrice(jsonPrice, jsonCurrency) : ''
  let listedPriceSource = jsonPrice ? 'json-ld offers.price' : undefined

  if (!listedPrice) {
    const metaPrice = metaContent(['meta[property="product:price:amount"]', 'meta[itemprop="price"]'])
      || attributeOrText(document, ['[itemprop="price"][content]'])
    const metaCurrency = metaContent(['meta[property="product:price:currency"]', 'meta[itemprop="priceCurrency"]'])
      || attributeOrText(document, ['[itemprop="priceCurrency"][content]'])
    if (metaPrice) {
      listedPrice = formatPrice(metaPrice, metaCurrency)
      listedCurrency = metaCurrency
      listedPriceSource = 'meta/itemprop price'
      dataSource.push('meta product price')
    }
  }
  if (!listedPrice) {
    const domPrice = attributeOrText(root, [
      '[itemprop="price"]',
      '[data-testid*="product-price"]',
      '[class*="product-detail-price" i]',
      '[class*="product-price" i]',
      '[id*="product-price" i]',
      '[data-price]',
    ])
    if (domPrice) {
      const currencyHint =
        metaContent(['meta[property="product:price:currency"]', 'meta[itemprop="priceCurrency"]']) ||
        attributeOrText(document, ['[itemprop="priceCurrency"]']) ||
        jsonCurrency
      listedPrice = /^\d[\d.,]*$/.test(domPrice) && currencyHint
        ? formatPrice(domPrice, currencyHint)
        : domPrice
      if (!listedCurrency && currencyHint) listedCurrency = currencyHint
      listedPriceSource = 'product price element'
      dataSource.push('dom product price')
    }
  }
  if (!listedPrice) {
    const fallback = fallbackVisiblePrice(root)
    if (fallback) {
      listedPrice = formatPrice(fallback.price, fallback.currency)
      listedPriceSource = 'visible text fallback'
      dataSource.push('visible text')
    }
  }

  const basketDiscount = extractBasketDiscount(root)
  const promotions = extractPromotions(root)
  if (basketDiscount.price) dataSource.push('visible DOM promotion')

  const title = compact(
    scalar(product?.name) ||
      firstText(root, [
        '#productTitle',
        'h1[itemprop="name"]',
        '[data-testid*="product-title"]',
        '[class*="product-title" i]',
        '[class*="product-name" i]',
        'h1',
        '[itemprop="name"]',
      ]) ||
      firstText(document, ['#productTitle', 'h1[itemprop="name"]', 'h1']) ||
      metaContent(['meta[property="og:title"]', 'meta[name="twitter:title"]']),
    200,
  )
  const descriptionSection =
    extractProductDescriptionSection(root) ||
    (root !== document.body ? extractProductDescriptionSection(document) : undefined)
  const descriptionText = descriptionSection
    || scalar(product?.description)
    || firstText(root, ['[itemprop="description"]', '[data-testid*="description"]', '[class*="product-description" i]', '[class~="description" i]'])
    || chunks.find((value) => value.length >= 80)
    || ''
  const description = compact(descriptionText, 1_200)
  const parsedDescription = parseSpecsFromDescription(descriptionText)
  const jsonSpecs = product ? jsonLdSpecs(product) : {}
  const rootSpecs = domSpecs(root, true)
  const technicalSpecs =
    root !== document.body && Object.keys(rootSpecs).length < 3
      ? { ...domSpecs(document.body, true), ...rootSpecs }
      : rootSpecs
  const specs = { ...technicalSpecs, ...jsonSpecs }
  for (const [key, value] of Object.entries(parsedDescription.descriptionSpecs)) {
    const exists = Object.keys(specs).some((current) => current.toLocaleLowerCase('tr-TR') === key.toLocaleLowerCase('tr-TR'))
    if (!exists) specs[key] = value
  }
  const specValue = (pattern: RegExp): string | undefined => {
    const entry = Object.entries(specs).find(([key]) => pattern.test(key.toLocaleLowerCase('tr-TR')))
    return entry?.[1]
  }
  const dimensionDetails: NonNullable<ProductContext['dimensionDetails']> = {
    ...parsedDescription.dimensionDetails,
    height: specValue(/^yükseklik$|ürün yüksekliği/),
    width: specValue(/^genişlik$|ürün genişliği/),
    depth: specValue(/^derinlik$|ürün derinliği/),
  }
  const extractionSources: string[] = []
  if (product) extractionSources.push('json-ld product')
  if (Object.keys(technicalSpecs).length) extractionSources.push('technical specs table')
  if (descriptionSection) extractionSources.push('product description section')
  const breadcrumbs = extractBreadcrumbs()
  const category = scalar(product?.category) || scalar(product?.pattern) || breadcrumbs.at(-1)
  const ratingObject = firstObject(product?.aggregateRating)
  const reviewCountValue = scalar(ratingObject?.reviewCount) || scalar(ratingObject?.ratingCount)
  const reviewCount = reviewCountValue ? Number(reviewCountValue) : undefined
  const rating = formatRating(ratingObject?.ratingValue)
  const domReviews = (() => {
    const rootReviews = visibleReviews(root)
    return rootReviews.length || root === document.body ? rootReviews : visibleReviews(document.body)
  })()
  const reviews = mergeReviews(jsonLdReviews(product), domReviews)
  const normalizedReviewCount = reviewCount !== undefined && Number.isFinite(reviewCount) ? reviewCount : reviews.length || undefined
  const reviewSummary = summarizeReviews(reviews, rating, normalizedReviewCount)
  const assemblyPattern = /\b(?:montaj|demonte|kurulum\w*|kurmas[ıi]|kurulmas[ıi]|assembly|assemble)\b|\bmonte\s+(?:ed|et|gel|ol|için|icin)/i
  const assemblyEvidence = unique(reviews
    .filter((review) => assemblyPattern.test(review.body) && (review.rating === undefined || review.rating <= 3 || /sorun|edemedim|eksik|zor|kırık|bozuk|uyumsuz/i.test(review.body)))
    .map((review) => review.body), 4)
  const explicitlyNoAssembly = /(?:kurulum|montaj)\s+(?:gerektirmez|gerekmez)|monte\s+gelir/i.test(descriptionText)
  const explicitlyRequiresAssembly = /(?:kurulum|montaj)\s+(?:gerektirir|gereklidir)|demont[eé]|kuruluma\s+hazır/i.test(descriptionText)
  const assemblyInfo: NonNullable<ProductContext['assemblyInfo']> = {
    requiresAssembly: explicitlyNoAssembly ? false : explicitlyRequiresAssembly ? true : undefined,
    assemblyDifficulty: assemblyEvidence.length ? 'possibly_difficult' : 'unknown',
    assemblyEvidence,
    cautionNotes: assemblyEvidence.length ? ['Bazı yorumlarda montajla ilgili sorun yaşandığı belirtilmiş.'] : [],
  }
  const qna = extractVisibleQna(root)
  const jsonImages = product ? extractImages(product.image) : []
  const images = jsonImages.length ? jsonImages : [visibleProductImage(root)].filter(Boolean)
  const sizeOptions = extractSizeOptions(root, product)
  const colors = extractColorOptions(root, product, specs)
  const modelMeasurements = extractModelMeasurements(root, descriptionText)
  const featureBullets = extractFeatures(root, specs)
  const known = new Set([title, listedPrice, basketDiscount.price || '', description, ...promotions, ...Object.entries(specs).flat(), ...featureBullets]
    .filter(Boolean).map((value) => value.toLocaleLowerCase()))
  const visibleTextSample = unique(chunks.filter((value) => !known.has(value.toLocaleLowerCase())))
    .join('\n').slice(0, MAX_SAMPLE_CHARS)

  if (!product && (title || description)) dataSource.push('visible dom')
    const context: ProductContext = {
    title: title || undefined,
    brand: namedValue(product?.brand)
      || namedValue(product?.manufacturer)
      || firstText(root, ['[itemprop="brand"]', '[data-testid*="brand"]', '[class*="product-brand" i]'])
      || undefined,
    sku: scalar(product?.sku) || undefined,
    price: listedPrice || undefined,
    priceSource: listedPriceSource,
    listedPrice: listedPrice || undefined,
    listedPriceSource,
    basketPrice: basketDiscount.price,
    basketPriceSource: basketDiscount.source,
    basketDiscountText: basketDiscount.text,
    promotions,
    priceFacts: {
      listedPrice: listedPrice || undefined,
      basketPrice: basketDiscount.price,
      discountText: basketDiscount.text,
      sourcePriority: ['json-ld offers.price', 'meta/itemprop price', 'product price element', 'visible text fallback'],
    },
    priceCurrency: listedCurrency || undefined,
    availability: normalizeAvailability(offer?.availability)
      || attributeOrText(root, ['[itemprop="availability"]', '[data-testid*="availability"]', '[class*="stock" i]'])
      || undefined,
    sizes: sizeOptions.sizes.length ? sizeOptions.sizes : undefined,
    inStockSizes: sizeOptions.inStockSizes.length ? sizeOptions.inStockSizes : undefined,
    outOfStockSizes: sizeOptions.outOfStockSizes.length ? sizeOptions.outOfStockSizes : undefined,
    selectedSize: sizeOptions.selectedSize,
    colors: colors.length ? colors : undefined,
    modelMeasurements: modelMeasurements.length ? modelMeasurements : undefined,
    url: location.href,
    category: category || undefined,
    breadcrumbs,
    description: description || undefined,
    descriptionText: descriptionText || undefined,
    descriptionSpecs: parsedDescription.descriptionSpecs,
    dimensionDetails,
    materialsAndBuild: parsedDescription.materialsAndBuild,
    comfortAndBuildFacts: parsedDescription.comfortAndBuildFacts,
    assemblyInfo,
    partsInfo: parsedDescription.partsInfo,
    featureBullets,
    specs,
    image: images[0],
    images,
    rating,
    reviewCount: normalizedReviewCount,
    reviews,
    reviewStats: { averageRating: rating, reviewCount: normalizedReviewCount },
    positiveReviewEvidence: reviewSummary.positiveSnippets,
    negativeReviewEvidence: reviewSummary.negativeSnippets,
    reviewSummary,
    qna,
    returnDays: product ? returnDays(product, offer) : undefined,
    returnPolicyText: product ? returnPolicyText(product, offer) : undefined,
    shippingFee: shippingFee(offer) || undefined,
    visibleTextSample: visibleTextSample || undefined,
    visibleTextEvidence: unique(chunks, 80),
    dataSource,
    extractionSources,
  }

  context.suggestedQuestions = getSuggestedQuestions(context)

  return context
}

export function hasProductContext(context: ProductContext): boolean {
  return Boolean(context.title && (context.listedPrice || context.basketPrice || context.description || Object.keys(context.specs).length || context.visibleTextSample))
}
