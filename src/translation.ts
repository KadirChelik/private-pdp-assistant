// General e-commerce & home-goods terminology glossary bridging Chrome's
// built-in Translator API (`tr <-> en`) with the English-only Prompt API.
export interface AnswerLanguageBridge {
  toModel(text: string): Promise<string>
  fromModel(text: string): Promise<string>
  destroy(): void
}

export const TURKISH_TRANSLATION_UNAVAILABLE =
  'Türkçe yanıt için Chrome Translator API kullanılamıyor. Chrome sürümünüzü güncelleyip tekrar deneyin.'

function looksTurkish(text: string): boolean {
  return /[çğıöşü]|\b(?:merhaba|urun|ürün|fiyat|renk|olcu|ölçü|yorum|malzeme|kac|kaç|nedir|kirmizi|kırmızı|beyaz|siyah|baza|bazali|bazalı|kurulum|montaj|monte|salon|salona|koltuk|kanepe|cekyat|çekyat|kisilik|kişilik|teslimat)\b/i.test(text)
}

function prepareTurkishForModel(text: string): string {
  return text
    .replace(/bazalı|bazali|bazal[ıi]/gi, 'with storage compartment')
    .replace(/\bbaza\b/gi, 'storage compartment')
    .replace(/\bkurulum\b|\bmontaj\b|\bmonte\b/gi, 'installation')
    .replace(/\bsalona\b|\bsalon\b/gi, 'living room')
    .replace(/\bkoltuk\b|\bkanepe\b/gi, 'sofa')
    .replace(/\bçekyat\b|\bcekyat\b/gi, 'sofa bed')
    .replace(/\bkişilik\b|\bkisilik\b/gi, 'people')
    .replace(/\bevet\b/gi, 'yes')
    .replace(/\bhayır\b|\bhayir\b/gi, 'no')
}

function prepareEnglishForTurkish(text: string): string {
  return text
    .replace(/\bassembly\b/gi, 'installation')
    .replace(/\bstorage base\b/gi, 'storage compartment')
    .replace(/\bbase storage\b/gi, 'storage compartment')
    .replace(/\bfoundation\b/gi, 'storage compartment')
    .replace(/\bseat height\b/gi, 'sitting height')
    .replace(/\bseat size\b/gi, 'sitting area size')
}

function polishTurkish(text: string): string {
  return text
    .replace(/Sepetteki ürün için\s+([0-9.,]+\s*TL)\s+tahsil edilecektir\.?/gi, 'Sepette fiyatı $1.')
    .replace(/\s*Lütfen bu fiyatın[^.!?]*(?:unutmayın|değişebileceğini unutmayın)\.?/gi, '')
    .replace(/\bYatak boyutu\b/gi, 'Yatak ölçüsü')
    .replace(/\byatak boyutu\b/gi, 'yatak ölçüsü')
    .replace(/\bSeans yüksekliği\b/gi, 'Oturum yüksekliği')
    .replace(/\bseans yüksekliği\b/gi, 'oturum yüksekliği')
    .replace(/\bbir saklama bölmesi var\b/gi, 'baza özelliği var')
    .replace(/\bsaklama bölmesi\b/gi, 'baza')
    .replace(/\bdepolama bölmesi\b/gi, 'baza')
    .replace(/\s*Opsiyon olarak mevcuttur\.?/gi, '')
    .replace(/\bBu ürün\s+(\d+)\s+kişi oturabilir\.?/gi, 'Bu ürün $1 kişilik.')
    .replace(/\bgridir\b/gi, 'gri')
    .replace(/\bmeclis(?:te|inde|i|e)?\b/gi, 'kurulum')
    .replace(/\bdepolama taban[ıi]\b/gi, 'baza')
    .replace(/\bsaklama taban[ıi]\b/gi, 'baza')
    .replace(/\btabanl[ıi]\b/gi, 'bazalı')
    .replace(/\s+/g, ' ')
    .replace(/\s+\./g, '.')
    .trim()
}

function progressMonitor(onProgress: (percent: number) => void): (target: EventTarget) => void {
  return (target) => {
    target.addEventListener('downloadprogress', (event) => {
      const loaded = (event as Event & { loaded?: number }).loaded
      if (typeof loaded !== 'number' || !Number.isFinite(loaded)) return
      onProgress(Math.round(Math.min(1, Math.max(0, loaded)) * 100))
    })
  }
}

export async function createTurkishBridge(
  onProgress: (percent: number) => void = () => undefined,
  signal?: AbortSignal,
): Promise<AnswerLanguageBridge> {
  if (!window.Translator?.create) throw new DOMException(TURKISH_TRANSLATION_UNAVAILABLE, 'NotSupportedError')

  const monitor = progressMonitor(onProgress)
  // Start both downloads while the submit/click user activation is still live.
  const toEnglishPromise = window.Translator.create({
    sourceLanguage: 'tr',
    targetLanguage: 'en',
    monitor,
    signal,
  })
  const toTurkishPromise = window.Translator.create({
    sourceLanguage: 'en',
    targetLanguage: 'tr',
    monitor,
    signal,
  })

  const [toEnglish, toTurkish] = await Promise.all([toEnglishPromise, toTurkishPromise])

  return {
    toModel: (text) => {
      const prepared = prepareTurkishForModel(text)
      return looksTurkish(text) || prepared !== text
        ? toEnglish.translate(prepared)
        : Promise.resolve(prepared)
    },
    fromModel: async (text) => polishTurkish(await toTurkish.translate(prepareEnglishForTurkish(text))),
    destroy: () => {
      toEnglish.destroy?.()
      toTurkish.destroy?.()
    },
  }
}
