export type Language = 'en' | 'ru'

export type DocumentStatus = 'ready' | 'processing' | 'queued'

export type DemoDocument = {
  id: string
  name: string
  type: 'PDF' | 'DOCX' | 'PPTX' | 'XLSX'
  size: string
  pages?: number
  slides?: number
  sheets?: number
  status: DocumentStatus
  progress?: number
  source: {
    en: string
    ru: string
  }
  excerpt: {
    en: string
    ru: string
  }
}

export type PipelineStep = {
  id: string
  label: {
    en: string
    ru: string
  }
  state: 'complete' | 'active' | 'pending'
}

export type Citation = {
  id: number
  documentId: string
  title: string
  place: {
    en: string
    ru: string
  }
  quote: {
    en: string
    ru: string
  }
}

export const copy = {
  en: {
    nav: ['Overview', 'Documents', 'Ask', 'Sources', 'Pipeline', 'Compare', 'Settings'],
    appTitle: 'RAG OCR Knowledge Agent',
    upload: 'Upload documents',
    search: 'Search documents...',
    documents: 'Documents',
    pipeline: 'Processing pipeline',
    ask: 'Ask',
    citations: 'Citations',
    preview: 'Preview',
    textOcr: 'Text OCR',
    metadata: 'Metadata',
    answerBased: 'Answer based on 3 sources',
    input: 'Ask a question about your documents...',
    ready: 'Ready',
    processing: 'Processing',
    queued: 'Queued',
    complete: 'Complete',
    inProgress: 'In progress',
    pending: 'Pending',
    pages: 'pages',
    slides: 'slides',
    sheets: 'sheets',
    selected: 'Selected',
    question: 'What was the revenue growth in 2023 and what factors drove it?',
    answer:
      'Revenue increased 24% year-over-year to $2.3B in 2023. The strongest drivers were enterprise segment expansion, improved operating efficiency, and higher retention in priority accounts.',
    localTitle: 'Local - stage 2',
    localText:
      'The same interface will later run with local OCR, local embeddings, and a private vector store.',
    compare: 'Compare with Local',
    privateData: 'Private data mode',
    adapters: 'Adapter-ready architecture',
    noAuth: 'No login needed for the demo',
    profile: 'Cloud',
    compareNew: 'New',
  },
  ru: {
    nav: ['Обзор', 'Документы', 'Вопрос', 'Источники', 'Pipeline', 'Сравнение', 'Настройки'],
    appTitle: 'RAG OCR Knowledge Agent',
    upload: 'Загрузить документы',
    search: 'Поиск по документам...',
    documents: 'Документы',
    pipeline: 'Pipeline обработки',
    ask: 'Вопрос',
    citations: 'Источники',
    preview: 'Просмотр',
    textOcr: 'Текст OCR',
    metadata: 'Метаданные',
    answerBased: 'Ответ по 3 источникам',
    input: 'Задайте вопрос по документам...',
    ready: 'Готово',
    processing: 'Обработка',
    queued: 'В очереди',
    complete: 'Готово',
    inProgress: 'В работе',
    pending: 'Ожидает',
    pages: 'стр.',
    slides: 'слайдов',
    sheets: 'листов',
    selected: 'Выбран',
    question: 'Как выросла выручка в 2023 году и какие факторы повлияли на рост?',
    answer:
      'Выручка выросла на 24% год к году и достигла $2.3B в 2023 году. Главные факторы - рост enterprise-сегмента, операционная эффективность и удержание ключевых клиентов.',
    localTitle: 'Локальный - этап 2',
    localText:
      'Позже этот же интерфейс будет работать с локальным OCR, локальными embeddings и приватным vector store.',
    compare: 'Сравнить с локальным режимом',
    privateData: 'Режим приватных данных',
    adapters: 'Архитектура на адаптерах',
    noAuth: 'Без авторизации для демо',
    profile: 'Облачный',
    compareNew: 'New',
  },
} as const

export const documents: DemoDocument[] = [
  {
    id: 'annual-report',
    name: 'Annual Report 2023.pdf',
    type: 'PDF',
    size: '18.4 MB',
    pages: 120,
    status: 'ready',
    source: {
      en: 'Page 12',
      ru: 'Страница 12',
    },
    excerpt: {
      en: 'Revenue increased 24% year-over-year to $2.3B, driven by enterprise demand and retention growth.',
      ru: 'Выручка выросла на 24% год к году до $2.3B за счет enterprise-спроса и удержания клиентов.',
    },
  },
  {
    id: 'product-specs',
    name: 'Product Specs.docx',
    type: 'DOCX',
    size: '2.1 MB',
    pages: 32,
    status: 'ready',
    source: {
      en: 'Page 7',
      ru: 'Страница 7',
    },
    excerpt: {
      en: 'Customer growth remained strong throughout 2023, especially in regulated industries.',
      ru: 'Рост клиентской базы оставался сильным в 2023 году, особенно в регулируемых отраслях.',
    },
  },
  {
    id: 'strategy-deck',
    name: 'Q4 Strategy Deck.pptx',
    type: 'PPTX',
    size: '5.7 MB',
    slides: 18,
    status: 'ready',
    source: {
      en: 'Slide 9',
      ru: 'Слайд 9',
    },
    excerpt: {
      en: 'The Q4 strategy focused on AI automation, partner channels, and faster onboarding.',
      ru: 'Стратегия Q4 была сфокусирована на AI-автоматизации, партнерах и быстром онбординге.',
    },
  },
  {
    id: 'financial-model',
    name: 'Financial Model.xlsx',
    type: 'XLSX',
    size: '1.3 MB',
    sheets: 8,
    status: 'ready',
    source: {
      en: 'Sheet: Summary',
      ru: 'Лист: Summary',
    },
    excerpt: {
      en: 'FY2023 revenue reached $2,300M, representing a 24% increase compared to FY2022.',
      ru: 'Выручка FY2023 достигла $2,300M, что на 24% выше результата FY2022.',
    },
  },
  {
    id: 'vendor-agreement',
    name: 'Vendor Agreement.pdf',
    type: 'PDF',
    size: '1.2 MB',
    pages: 24,
    status: 'processing',
    progress: 62,
    source: {
      en: 'Page 4',
      ru: 'Страница 4',
    },
    excerpt: {
      en: 'OCR is extracting vendor payment terms and renewal clauses.',
      ru: 'OCR извлекает условия оплаты поставщика и пункты продления.',
    },
  },
  {
    id: 'market-research',
    name: 'Market Research 2024.pdf',
    type: 'PDF',
    size: '9.8 MB',
    pages: 95,
    status: 'queued',
    source: {
      en: 'Queued',
      ru: 'В очереди',
    },
    excerpt: {
      en: 'Queued for OCR and semantic indexing.',
      ru: 'Ожидает OCR и семантической индексации.',
    },
  },
]

export const pipelineSteps: PipelineStep[] = [
  { id: 'upload', label: { en: 'Upload', ru: 'Загрузка' }, state: 'complete' },
  { id: 'ocr', label: { en: 'OCR', ru: 'OCR' }, state: 'active' },
  { id: 'chunking', label: { en: 'Chunking', ru: 'Чанкинг' }, state: 'pending' },
  { id: 'embedding', label: { en: 'Embedding', ru: 'Embedding' }, state: 'pending' },
]

export const citations: Citation[] = [
  {
    id: 1,
    documentId: 'annual-report',
    title: 'Annual Report 2023.pdf',
    place: { en: 'Page 12', ru: 'Страница 12' },
    quote: {
      en: 'Revenue increased 24% year-over-year to $2.3B, driven by strong performance across all segments.',
      ru: 'Выручка выросла на 24% год к году до $2.3B за счет сильной динамики во всех сегментах.',
    },
  },
  {
    id: 2,
    documentId: 'product-specs',
    title: 'Product Specs.docx',
    place: { en: 'Page 7', ru: 'Страница 7' },
    quote: {
      en: 'Customer growth remained strong throughout 2023, contributing to record revenue.',
      ru: 'Рост клиентской базы оставался сильным в течение 2023 года и поддержал рекордную выручку.',
    },
  },
  {
    id: 3,
    documentId: 'financial-model',
    title: 'Financial Model.xlsx',
    place: { en: 'Sheet: Summary', ru: 'Лист: Summary' },
    quote: {
      en: 'FY2023 revenue: $2,300M, a 24% increase compared to FY2022.',
      ru: 'Выручка FY2023: $2,300M, рост на 24% относительно FY2022.',
    },
  },
]
