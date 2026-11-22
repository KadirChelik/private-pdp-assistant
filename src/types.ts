export interface ProductReview {
  rating?: number
  body: string
  date?: string
}

export interface ReviewStats {
  averageRating?: string
  reviewCount?: number
}

export interface ReviewSummary {
  averageRating?: string
  reviewCount?: number
  positiveSnippets?: string[]
  negativeSnippets?: string[]
  commonThemes?: string[]
  deliveryMentions?: string[]
  usabilityMentions?: string[]
  packagingMentions?: string[]
  assemblyMentions?: string[]
}

export interface ProductQna {
  question: string
  answer?: string
}

export interface PriceFacts {
  listedPrice?: string
  basketPrice?: string
  discountText?: string
  sourcePriority?: string[]
}

export interface AssemblyInfo {
  requiresAssembly?: boolean
  assemblyDifficulty?: 'unknown' | 'easy' | 'mixed' | 'possibly_difficult'
  assemblyEvidence?: string[]
  cautionNotes?: string[]
}

export interface PartsInfo {
  plasticLegs?: string
  hiddenSupportLegs?: string
  frame?: string
  base?: string
  spring?: string
  supportBlocks?: string
  armFrame?: string
  knownParts?: string[]
  exactPackagePieceCount?: string
}

export interface DimensionDetails {
  height?: string
  width?: string
  depth?: string
  sittingHeight?: string
  legHeight?: string
  seatSize?: string
  backSize?: string
  bedSize?: string
}

export interface MaterialsAndBuild {
  frame?: string
  fabric?: string
  base?: string
  spring?: string
  sponge?: string
  legs?: string
  supportLegs?: string
}

export interface ProductContext {
  title?: string
  brand?: string
  sku?: string

  price?: string
  priceSource?: string
  listedPrice?: string
  listedPriceSource?: string
  basketPrice?: string
  basketPriceSource?: string
  basketDiscountText?: string
  promotions?: string[]
  priceFacts?: PriceFacts
  priceCurrency?: string

  availability?: string
  sizes?: string[]
  inStockSizes?: string[]
  outOfStockSizes?: string[]
  selectedSize?: string
  colors?: string[]
  variants?: string[]
  modelMeasurements?: string[]
  url: string
  category?: string
  breadcrumbs?: string[]

  description?: string
  descriptionText?: string
  descriptionSpecs?: Record<string, string>
  featureBullets?: string[]

  specs: Record<string, string>

  comfortAndBuildFacts?: string[]
  dimensionDetails?: DimensionDetails
  materialsAndBuild?: MaterialsAndBuild
  assemblyInfo?: AssemblyInfo
  partsInfo?: PartsInfo

  image?: string
  images?: string[]

  rating?: string
  reviewCount?: number
  reviews?: ProductReview[]
  reviewStats?: ReviewStats
  positiveReviewEvidence?: string[]
  negativeReviewEvidence?: string[]
  reviewSummary?: ReviewSummary

  qna?: ProductQna[]

  returnDays?: number
  returnPolicyText?: string
  shippingFee?: string

  visibleTextSample?: string
  visibleTextEvidence?: string[]

  dataSource?: string[]
  extractionSources?: string[]

  suggestedQuestions?: string[]
}

export type EvidenceType =
  | 'title'
  | 'brand'
  | 'sku'
  | 'price'
  | 'basketPrice'
  | 'promotion'
  | 'availability'
  | 'category'
  | 'breadcrumb'
  | 'spec'
  | 'descriptionSpec'
  | 'descriptionSentence'
  | 'feature'
  | 'material'
  | 'dimension'
  | 'assembly'
  | 'part'
  | 'review'
  | 'qna'
  | 'rating'
  | 'shipping'
  | 'returnPolicy'
  | 'image'

export interface EvidenceItem {
  id: string
  type: EvidenceType
  label?: string
  value: string
  source: string
  searchableText: string
  score?: number
}

export interface RetrievedEvidence {
  query: string
  items: EvidenceItem[]
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

export type AssistantMode = 'hybrid' | 'local-only'

export type AnswerEngine = 'cloud' | 'local-extractive' | 'local-gate'

export interface PDPAssistantConfig {
  apiEndpoint?: string
  mode?: AssistantMode
}

declare global {
  interface Window {
    PDPAssistantConfig?: PDPAssistantConfig
    PDPAssistant?: {
      mount: () => void
      unmount: () => void
      refresh?: () => void
      debugContext?: () => ProductContext
      debugEvidenceIndex?: () => EvidenceItem[]
      debugRetrieveEvidence?: (question: string) => EvidenceItem[]
      detectIntent?: (question: string) => string
    }
  }
}
