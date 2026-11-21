import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

import { getSuggestedQuestions, parseSpecsFromDescription } from '../src/extractor.ts'
import {
  answerQuestion,
  createSession,
  detectQuestionIntent,
  isTurkishText,
  retrieveEvidence,
} from '../src/nano.ts'
import { createTurkishBridge } from '../src/translation.ts'
import type { EvidenceItem, LanguageModelSession, ProductContext } from '../src/types.ts'

function installDom(html: string, url = 'https://shop.test/main-product'): () => void {
  const dom = new JSDOM(html, { url })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    HTMLElement: dom.window.HTMLElement,
    HTMLMetaElement: dom.window.HTMLMetaElement,
    HTMLLinkElement: dom.window.HTMLLinkElement,
    Element: dom.window.Element,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  }
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
    configurable: true,
    value: () => [{ width: 100, height: 20 }],
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { return this.textContent || '' },
  })
  return () => {
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
}

test('detectQuestionIntent recognizes core Turkish and English intents', () => {
  assert.equal(detectQuestionIntent('Sepette fiyatı ne kadar?'), 'price')
  assert.equal(detectQuestionIntent('Yatak ölçüsü nedir?'), 'openedBedDimensions')
  assert.equal(detectQuestionIntent('What material is it made of?'), 'material')
  assert.equal(detectQuestionIntent('What do customer reviews say?'), 'reviews')
})

test('retrieveEvidence does not return unrelated facts for an unknown question', () => {
  const evidence: EvidenceItem[] = [{
    id: 'spec-color',
    type: 'spec',
    label: 'Color',
    value: 'Green',
    source: 'product specs',
    searchableText: 'Color Green',
  }]

  assert.deepEqual(retrieveEvidence('Does it support Bluetooth?', evidence), [])
})

test('retrieveEvidence prioritizes the matching fact', () => {
  const evidence: EvidenceItem[] = [
    { id: 'weight', type: 'spec', label: 'Weight', value: '980 g', source: 'specs', searchableText: 'Weight 980 g' },
    { id: 'color', type: 'spec', label: 'Color', value: 'Moss green', source: 'specs', searchableText: 'Color Moss green' },
  ]

  const result = retrieveEvidence('What color is it?', evidence)
  assert.equal(result[0]?.id, 'color')
})

test('description parser extracts and normalizes furniture dimensions', () => {
  const parsed = parseSpecsFromDescription('Oturum yüksekliği: 45 cm\nYatak ölçüsü: 190 x 90 cm')

  assert.equal(parsed.dimensionDetails.sittingHeight, '45 cm')
  assert.equal(parsed.dimensionDetails.bedSize, '190×90 cm')
})

test('suggested questions are contextual instead of furniture-only defaults', () => {
  const context: ProductContext = {
    url: 'https://example.test/product',
    title: 'Trail Pack',
    listedPrice: '129 USD',
    specs: { Material: 'Ripstop nylon', Capacity: '28 litres' },
  }

  const questions = getSuggestedQuestions(context)
  assert.ok(questions.includes('What is the price?'))
  assert.ok(questions.includes('What is its capacity?'))
  assert.ok(questions.includes('What is it made of?'))
  assert.ok(!questions.some((question) => question.toLowerCase().includes('bed')))
})

test('suggested questions include a review summary question when reviews exist', () => {
  const restore = installDom('<!doctype html><html lang="tr"><body><main>Ürün</main></body></html>')
  try {
    const context: ProductContext = {
      url: 'https://example.test/product',
      title: 'Kanepe',
      specs: {},
      reviewCount: 24,
      reviews: [{ rating: 5, body: 'Ürün rahat ve kullanışlı.' }],
    }

    const questions = getSuggestedQuestions(context)
    assert.ok(questions.includes('Yorumlar nasıl?'))
  } finally {
    restore()
  }
})

test('createSession starts creation when the model is downloadable', async () => {
  let createCalls = 0
  let requestedOptions: unknown
  const session: LanguageModelSession = {
    prompt: async () => 'answer',
    destroy: () => undefined,
  }
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window: unknown }).window = {
    localStorage: { getItem: () => null },
    LanguageModel: {
      availability: async () => 'downloadable',
      create: async (options: unknown) => {
        createCalls += 1
        requestedOptions = options
        return session
      },
    },
  }

  try {
    assert.equal(await createSession(), session)
    assert.equal(createCalls, 1)
    assert.ok(!JSON.stringify(requestedOptions).includes('"tr"'))
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window: unknown }).window = previousWindow
  }
})

test('Turkish detection handles natural questions', () => {
  assert.equal(isTurkishText('Bu ürünün rengi nedir?'), true)
  assert.equal(isTurkishText('What color is this product?'), false)
})

test('Turkish bridge creates both local translation directions', async () => {
  const createdPairs: string[] = []
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window: unknown }).window = {
    Translator: {
      create: async ({ sourceLanguage, targetLanguage }: { sourceLanguage: string; targetLanguage: string }) => {
        createdPairs.push(`${sourceLanguage}-${targetLanguage}`)
        return { translate: async (text: string) => `${targetLanguage}:${text}` }
      },
    },
  }

  try {
    const bridge = await createTurkishBridge()
    assert.deepEqual(createdPairs, ['tr-en', 'en-tr'])
    assert.equal(await bridge.toModel('merhaba'), 'en:merhaba')
    assert.equal(
      await bridge.toModel('Bazalı kanepe kurulum için salona uygun mu?'),
      'en:with storage compartment sofa installation için living room uygun mu?',
    )
    assert.equal(await bridge.toModel('plain English evidence'), 'plain English evidence')
    assert.equal(await bridge.fromModel('Assembly and storage base'), 'tr:installation and storage compartment')
    bridge.destroy()
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window: unknown }).window = previousWindow
  }
})

test('Turkish bridge polishes awkward shopping and furniture translations', async () => {
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window: unknown }).window = {
    Translator: {
      create: async ({ targetLanguage }: { sourceLanguage: string; targetLanguage: string }) => ({
        translate: async (text: string) => targetLanguage === 'tr'
          ? text
              .replace(
                'The basket price is 9.949 TL.',
                'Sepetteki ürün için 9.949 TL tahsil edilecektir. Lütfen bu fiyatın başka öğeler ekledikten sonra değişebileceğini unutmayın.',
              )
              .replace('The bed size is 105×190.', 'Yatak boyutu 105×190.')
              .replace('It has a storage compartment.', 'Bu kanepenin bir saklama bölmesi var. Opsiyon olarak mevcuttur.')
              .replace('This product seats 3 people.', 'Bu ürün 3 kişi oturabilir.')
          : text,
      }),
    },
  }

  try {
    const bridge = await createTurkishBridge()
    assert.equal(await bridge.fromModel('The basket price is 9.949 TL.'), 'Sepette fiyatı 9.949 TL.')
    assert.equal(await bridge.fromModel('The bed size is 105×190.'), 'Yatak ölçüsü 105×190.')
    assert.equal(await bridge.fromModel('It has a storage compartment.'), 'Bu kanepenin baza özelliği var.')
    assert.equal(await bridge.fromModel('This product seats 3 people.'), 'Bu ürün 3 kişilik.')
    bridge.destroy()
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window: unknown }).window = previousWindow
  }
})

test('answerQuestion translates model input and localizes the final answer', async () => {
  let capturedPrompt = ''
  const session: LanguageModelSession = {
    prompt: async (prompt) => {
      capturedPrompt = prompt
      return 'The product is red.'
    },
    destroy: () => undefined,
  }
  const context: ProductContext = {
    url: 'https://example.test/product',
    title: 'Deneme Ürün',
    specs: { Malzeme: 'Çelik gövde' },
  }
  const bridge = {
    toModel: async (text: string) => `ENGLISH:${text}`,
    fromModel: async () => 'Ürün kırmızıdır.',
    destroy: () => undefined,
  }

  const answer = await answerQuestion(session, context, 'Dayanıklı mı?', undefined, bridge)
  assert.match(capturedPrompt, /ENGLISH:Dayanıklı mı\?/)
  assert.match(capturedPrompt, /ENGLISH:.*Çelik gövde/s)
  assert.match(answer, /Ürün kırmızıdır\./)
  assert.doesNotMatch(answer, /Kullanılan bilgiler:|Kaynak:|Kanıt:/)
})

test('answerQuestion sends factual questions to the model instead of direct shortcuts', async () => {
  let calls = 0
  let capturedPrompt = ''
  const session: LanguageModelSession = {
    prompt: async (prompt) => {
      calls += 1
      capturedPrompt = prompt
      return 'The basket price is 9.949 TL.'
    },
    destroy: () => undefined,
  }
  const context: ProductContext = {
    url: 'https://example.test/product',
    title: 'Sofa',
    basketPrice: '9.949 TL',
    basketDiscountText: 'Sepette 9.949 TL',
  }

  const answer = await answerQuestion(session, context, 'What is the basket price?')

  assert.equal(calls, 1)
  assert.match(capturedPrompt, /Basket price: 9\.949 TL/)
  assert.equal(answer, 'The basket price is 9.949 TL.')
})

test('living-room suitability uses broad product evidence instead of returning not found', async () => {
  let capturedPrompt = ''
  const session: LanguageModelSession = {
    prompt: async (prompt) => {
      capturedPrompt = prompt
      return 'It appears suitable for a living room because it is a sofa bed with a grey color and listed dimensions, but compare the width with your room before buying.'
    },
    destroy: () => undefined,
  }
  const context: ProductContext = {
    url: 'https://example.test/product',
    title: 'Serra 3 Kişilik Bazalı Kanepe Çekyat Koltuk Gri',
    category: 'Kanepe',
    specs: { Renk: 'Gri', Kapasitesi: '3 Kişilik', Katlanır: 'Evet' },
    dimensionDetails: { width: '220 cm', depth: '55 cm', height: '88 cm' },
    materialsAndBuild: { fabric: 'Keten', frame: 'Metal' },
  }

  const answer = await answerQuestion(session, context, 'Salona uygun mu?')

  assert.match(capturedPrompt, /Detected intent: suitability/)
  assert.match(capturedPrompt, /Serra 3 Kişilik Bazalı Kanepe/)
  assert.match(capturedPrompt, /220 cm/)
  assert.match(answer, /appears suitable/)
})

test('review questions send rating and balanced review signals to the model', async () => {
  let capturedPrompt = ''
  const session: LanguageModelSession = {
    prompt: async (prompt) => {
      capturedPrompt = prompt
      return 'The product has a 4.4/5 rating from 24 reviews. Customers often praise comfort and delivery, while some mention installation difficulty.'
    },
    destroy: () => undefined,
  }
  const context: ProductContext = {
    url: 'https://example.test/product',
    title: 'Sofa',
    specs: {},
    rating: '4.4',
    reviewCount: 24,
    reviewSummary: {
      averageRating: '4.4',
      reviewCount: 24,
      commonThemes: ['teslimat', 'kullanışlılık', 'montaj'],
      positiveSnippets: ['Rahat ve kullanışlı, teslimat da hızlıydı.'],
      negativeSnippets: ['Kurulum sırasında zorlandım.'],
    },
  }

  await answerQuestion(session, context, 'Yorumlar nasıl?')

  assert.match(capturedPrompt, /4\.4 \/ 5/)
  assert.match(capturedPrompt, /24 reviews/)
  assert.match(capturedPrompt, /Positive review signal/)
  assert.match(capturedPrompt, /Critical review signal/)
  assert.match(capturedPrompt, /Do not let one installation complaint represent all reviews/)
})

test('model evidence/source appendices are removed from the final answer', async () => {
  const session: LanguageModelSession = {
    prompt: async () => 'It has a steel frame. **Evidence:** Material: Steel — Source: product specs',
    destroy: () => undefined,
  }
  const context: ProductContext = {
    url: 'https://example.test/product',
    title: 'Chair',
    specs: { Material: 'Steel frame' },
  }

  assert.equal(await answerQuestion(session, context, 'Is it durable?'), 'It has a steel frame.')
})

test('extractProductContext selects the main JSON-LD product and scopes promotions', async () => {
  const restore = installDom(`<!doctype html><html lang="en"><head>
    <link rel="canonical" href="https://shop.test/main-product">
    <script type="application/ld+json">[
      {"@type":"Product","name":"Recommended Product","url":"/recommended","offers":{"price":"999","priceCurrency":"TRY"}},
      {"@type":"Product","name":"Main Product","url":"/main-product","sku":"MAIN-1","brand":{"name":"Acme"},"offers":{"price":"100","priceCurrency":"TRY","availability":"https://schema.org/InStock"},"aggregateRating":{"ratingValue":"4.5","reviewCount":"12"}}
    ]</script>
  </head><body>
    <div class="discount-price">Unrelated 5 TL</div>
    <main class="product-detail"><h1>Main Product</h1><span itemprop="sku">MAIN-1</span>
      <p itemprop="description">A durable product description with enough visible detail for extraction.</p>
      <div class="discount-price">Sepette 80 TL</div>
      <table><tr><th>Material</th><td>Steel</td></tr><tr><th>Color</th><td>Orange</td></tr></table>
      <article itemprop="review"><p itemprop="reviewBody">Very useful and well packaged.</p><meta itemprop="ratingValue" content="5"></article>
      <section itemtype="https://schema.org/Question"><h3 itemprop="name">Warranty?</h3><div itemprop="acceptedAnswer"><span itemprop="text">Two years.</span></div></section>
    </main>
  </body></html>`)

  try {
    const { extractProductContext } = await import('../src/extractor.ts')
    const context = extractProductContext()
    assert.equal(context.title, 'Main Product')
    assert.equal(context.sku, 'MAIN-1')
    assert.equal(context.brand, 'Acme')
    assert.equal(context.listedPrice, '100 TL')
    assert.equal(context.basketPrice, '80 TL')
    assert.equal(context.availability, 'InStock')
    assert.equal(context.specs.Material, 'Steel')
    assert.equal(context.rating, '4.5')
    assert.equal(context.reviewCount, 12)
    assert.equal(context.qna?.[0]?.answer, 'Two years.')
  } finally {
    restore()
  }
})

test('extractProductContext falls back to visible DOM when JSON-LD is invalid', async () => {
  const restore = installDom(`<!doctype html><html lang="en"><head>
    <script type="application/ld+json">{invalid json</script>
    <meta property="product:price:amount" content="49.90">
    <meta property="product:price:currency" content="USD">
  </head><body><main class="product-detail">
    <h1>DOM Product</h1><div itemprop="brand">DOM Brand</div>
    <p itemprop="description">A complete visible description used when structured data is unavailable.</p>
    <ul class="specs"><li><span>Capacity</span><strong>20 L</strong></li></ul>
  </main></body></html>`)

  try {
    const { extractProductContext, hasProductContext } = await import('../src/extractor.ts')
    const context = extractProductContext()
    assert.equal(context.title, 'DOM Product')
    assert.equal(context.brand, 'DOM Brand')
    assert.equal(context.listedPrice, '49.90 USD')
    assert.equal(context.specs.Capacity, '20 L')
    assert.equal(hasProductContext(context), true)
  } finally {
    restore()
  }
})

test('extractProductContext ignores elements marked with data-pdp-assistant-ignore', async () => {
  const restore = installDom(`<!doctype html><html lang="en"><body>
    <main class="product-detail">
      <h1>Trail Pack 28L</h1>
      <div class="price" itemprop="price">$129.00</div>
      <ul class="specs"><li><span>Capacity</span><strong>28 litres</strong></li></ul>
    </main>
    <section id="pipeline-inspector" data-pdp-assistant-ignore>
      <h2>Pipeline Inspector</h2>
      <ul class="specs"><li><span>Fake Spec</span><strong>Should Not Leak</strong></li></ul>
      <article itemprop="review"><p itemprop="reviewBody">Inspector noise review.</p></article>
    </section>
  </body></html>`)

  try {
    const { extractProductContext } = await import('../src/extractor.ts')
    const context = extractProductContext()
    assert.equal(context.specs.Capacity, '28 litres')
    assert.equal(context.specs['Fake Spec'], undefined)
    assert.equal(context.reviews?.length ?? 0, 0)
    assert.ok(!(context.visibleTextSample || '').includes('Should Not Leak'))
  } finally {
    restore()
  }
})

test('generic non-furniture product extraction and retrieval match specs/reviews and reject absent attributes', async () => {
  const restore = installDom(`<!doctype html><html lang="en"><head>
    <script type="application/ld+json">{
      "@type": "Product",
      "name": "Terra Trail Pack 28L",
      "description": "A weather-resistant daypack built for long trails and contoured shoulder straps.",
      "sku": "TTP-28-MOSS",
      "brand": { "@type": "Brand", "name": "Northwind Goods" },
      "offers": { "@type": "Offer", "price": "129.00", "priceCurrency": "USD", "availability": "https://schema.org/InStock" },
      "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.8", "reviewCount": "2" },
      "review": [
        { "@type": "Review", "reviewRating": { "@type": "Rating", "ratingValue": "5" }, "reviewBody": "Light on the shoulders even on long day hikes." },
        { "@type": "Review", "reviewRating": { "@type": "Rating", "ratingValue": "4" }, "reviewBody": "Tough ripstop fabric handles wet trail conditions well." }
      ]
    }</script>
  </head><body>
    <main class="product-detail">
      <h1>Terra Trail Pack 28L</h1>
      <ul class="specs">
        <li><span>Capacity</span><strong>28 litres</strong></li>
        <li><span>Weight</span><strong>980 g</strong></li>
        <li><span>Warranty</span><strong>Lifetime repairs</strong></li>
      </ul>
    </main>
  </body></html>`)

  try {
    const { extractProductContext } = await import('../src/extractor.ts')
    const { buildEvidenceIndex } = await import('../src/nano.ts')
    const context = extractProductContext()
    const index = buildEvidenceIndex(context)

    const capacityHits = retrieveEvidence('What is the capacity and weight?', index)
    assert.ok(capacityHits.some((item) => item.value.includes('28 litres')))

    const warrantyHits = retrieveEvidence('What is the warranty?', index)
    assert.ok(warrantyHits.some((item) => item.value.includes('Lifetime repairs')))

    const reviewHits = retrieveEvidence('What do customer reviews say?', index)
    assert.ok(reviewHits.some((item) => item.type === 'rating' || item.type === 'review'))

    const absentHits = retrieveEvidence('Does it come in red?', index)
    assert.deepEqual(absentHits, [])
  } finally {
    restore()
  }
})
