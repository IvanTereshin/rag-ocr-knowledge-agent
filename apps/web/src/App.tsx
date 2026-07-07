import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ComponentType, FormEvent } from 'react'
import Bot from 'lucide-react/dist/esm/icons/bot.mjs'
import Check from 'lucide-react/dist/esm/icons/check.mjs'
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.mjs'
import CircleDot from 'lucide-react/dist/esm/icons/circle-dot.mjs'
import ClipboardList from 'lucide-react/dist/esm/icons/clipboard-list.mjs'
import CloudUpload from 'lucide-react/dist/esm/icons/cloud-upload.mjs'
import Database from 'lucide-react/dist/esm/icons/database.mjs'
import FileSpreadsheet from 'lucide-react/dist/esm/icons/file-spreadsheet.mjs'
import FileText from 'lucide-react/dist/esm/icons/file-text.mjs'
import FolderKanban from 'lucide-react/dist/esm/icons/folder-kanban.mjs'
import Languages from 'lucide-react/dist/esm/icons/languages.mjs'
import Layers3 from 'lucide-react/dist/esm/icons/layers-3.mjs'
import Menu from 'lucide-react/dist/esm/icons/menu.mjs'
import MessageSquareText from 'lucide-react/dist/esm/icons/message-square-text.mjs'
import MoreHorizontal from 'lucide-react/dist/esm/icons/more-horizontal.mjs'
import Paperclip from 'lucide-react/dist/esm/icons/paperclip.mjs'
import Search from 'lucide-react/dist/esm/icons/search.mjs'
import SendHorizontal from 'lucide-react/dist/esm/icons/send-horizontal.mjs'
import KeyRound from 'lucide-react/dist/esm/icons/key-round.mjs'
import Lock from 'lucide-react/dist/esm/icons/lock.mjs'
import LogOut from 'lucide-react/dist/esm/icons/log-out.mjs'
import Save from 'lucide-react/dist/esm/icons/save.mjs'
import Settings from 'lucide-react/dist/esm/icons/settings.mjs'
import ShieldCheck from 'lucide-react/dist/esm/icons/shield-check.mjs'
import Sparkles from 'lucide-react/dist/esm/icons/sparkles.mjs'
import SplitSquareHorizontal from 'lucide-react/dist/esm/icons/split-square-horizontal.mjs'
import Upload from 'lucide-react/dist/esm/icons/upload.mjs'
import Workflow from 'lucide-react/dist/esm/icons/workflow.mjs'
import './App.css'
import { api } from './api'
import type {
  AgentMode,
  AskResponse,
  EditableProxySettings,
  EditableServiceSettings,
  ProxySettings,
  ServiceProvider,
  ServiceSettings,
  User,
  UserDocument,
} from './api'
import { copy } from './data'
import type { Language } from './data'

type IconComponent = ComponentType<{ size?: number | string; className?: string }>
type DocumentsStatus = 'loading' | 'ready' | 'uploading'
type PipelineStep = UserDocument['pipeline'][number]
const rerankerProviders = ['cohere', 'voyage', 'jina', 'tei'] as const
type RerankerProvider = (typeof rerankerProviders)[number]

function isRerankerProvider(provider: ServiceProvider): provider is RerankerProvider {
  return rerankerProviders.includes(provider as RerankerProvider)
}

function serviceRequiresApiKey(provider: ServiceProvider) {
  return provider !== 'tei'
}

function proxyAppliesToProvider(provider: ServiceProvider) {
  return provider === 'openai' || provider === 'cohere' || provider === 'voyage' || provider === 'jina'
}

const agentModeStorageKey = 'rag-ocr-agent-mode'

function getInitialAgentMode(): AgentMode {
  return window.localStorage.getItem(agentModeStorageKey) === 'local' ? 'local' : 'cloud'
}

const navIcons: IconComponent[] = [
  FolderKanban,
  ClipboardList,
  MessageSquareText,
  Layers3,
  Workflow,
  SplitSquareHorizontal,
  Settings,
]

const fileIcons: Record<string, IconComponent> = {
  PDF: FileText,
  DOC: FileText,
  DOCX: FileText,
  TXT: FileText,
  MD: FileText,
  PPT: ClipboardList,
  PPTX: ClipboardList,
  XLS: FileSpreadsheet,
  XLSX: FileSpreadsheet,
  CSV: FileSpreadsheet,
  PNG: FileText,
  JPG: FileText,
  JPEG: FileText,
  FILE: FileText,
}

const statusTone: Record<UserDocument['status'], string> = {
  uploaded: 'active',
  ready: 'success',
  processing: 'active',
  queued: 'muted',
  failed: 'danger',
}

const fallbackPipelineSteps: PipelineStep[] = [
  { id: 'extract', status: 'pending' },
  { id: 'chunk', status: 'pending' },
  { id: 'index', status: 'pending' },
]

const pipelineStepText = {
  ru: {
    extract: 'Извлечение текста',
    chunk: 'Чанкинг',
    index: 'Индекс',
  },
  en: {
    extract: 'Text extraction',
    chunk: 'Chunking',
    index: 'Index',
  },
} as const

const authText = {
  ru: {
    registerTitle: 'Создать доступ к агенту',
    loginTitle: 'Войти в рабочее пространство',
    subtitle: 'Регистрация нужна, чтобы хранить настройки API и документы отдельно для каждого пользователя.',
    register: 'Регистрация',
    login: 'Вход',
    name: 'Имя',
    email: 'Email',
    password: 'Пароль',
    createAccount: 'Создать аккаунт',
    enter: 'Войти',
    submitting: 'Проверяем...',
    genericError: 'Не удалось выполнить запрос',
  },
  en: {
    registerTitle: 'Create agent access',
    loginTitle: 'Sign in to workspace',
    subtitle: 'Authentication keeps API settings and documents separated for every user.',
    register: 'Register',
    login: 'Login',
    name: 'Name',
    email: 'Email',
    password: 'Password',
    createAccount: 'Create account',
    enter: 'Sign in',
    submitting: 'Checking...',
    genericError: 'Request failed',
  },
} as const

const settingsText = {
  ru: {
    title: 'Настройки сервисов',
    subtitle:
      'Подключите API-ключи для OCR, генерации ответов, reranking и vector search. Ключи сохраняются на backend и не попадают в браузер после сохранения.',
    secureStorage: 'Зашифрованное хранение',
    account: 'Аккаунт',
    baseUrl: 'Base URL',
    model: 'Модель / профиль',
    apiKey: 'API key',
    apiKeyOptional: 'API key, если TEI закрыт авторизацией',
    apiKeyPlaceholder: 'Вставьте ключ сервиса',
    savedKey: 'Сохранён ключ, последние символы:',
    rerankerProvider: 'Reranker Provider',
    rerankerSubtitle: 'Выберите один сервис, который будет переупорядочивать найденные чанки перед ответом.',
    selectedReranker: 'Выбранный reranker',
    availableReranker: 'Доступен для выбора',
    proxyTitle: 'Proxy для API',
    proxySubtitle: 'Используется для OpenAI и облачных reranker API, если прямой запрос с сервера блокируется.',
    proxyAppliedTo: 'Применяется к OpenAI, Cohere, Voyage AI и Jina AI',
    proxyUrl: 'Proxy URL',
    proxyUrlPlaceholder: 'Например http://user:pass@host:port',
    savedProxy: 'Сохранён proxy, последние символы:',
    proxySaved: 'Proxy сохранён',
    proxyMissing: 'Proxy не добавлен',
    keySaved: 'Ключ сохранён',
    keyMissing: 'Ключ ещё не добавлен',
    keyOptional: 'Ключ не обязателен для Local TEI',
    clear: 'Очистить',
    clearProxy: 'Очистить proxy',
    loading: 'Загружаем настройки',
    ready: 'Готово к сохранению',
    saving: 'Сохраняем и проверяем...',
    saved: 'Сохранено',
    save: 'Сохранить настройки',
    loadError: 'Не удалось загрузить настройки',
    saveError: 'Не удалось сохранить настройки',
    validationChanged: 'Есть изменения, сохраните для проверки',
    validationValid: 'Ключ работает',
    validationInvalid: 'Ключ не работает',
    validationSkipped: 'Проверка пропущена',
    validationUnchecked: 'Не проверялся',
  },
  en: {
    title: 'Service settings',
    subtitle:
      'Connect API keys for OCR, answer generation, reranking, and vector search. Keys are stored on the backend and are not returned to the browser after saving.',
    secureStorage: 'Encrypted storage',
    account: 'Account',
    baseUrl: 'Base URL',
    model: 'Model / profile',
    apiKey: 'API key',
    apiKeyOptional: 'API key if TEI is protected',
    apiKeyPlaceholder: 'Paste service key',
    savedKey: 'Saved key, last chars:',
    rerankerProvider: 'Reranker Provider',
    rerankerSubtitle: 'Choose one service that reranks retrieved chunks before answer generation.',
    selectedReranker: 'Selected reranker',
    availableReranker: 'Available option',
    proxyTitle: 'API proxy',
    proxySubtitle: 'Used when OpenAI and cloud reranker API checks are blocked from the server.',
    proxyAppliedTo: 'Applied to OpenAI, Cohere, Voyage AI, and Jina AI',
    proxyUrl: 'Proxy URL',
    proxyUrlPlaceholder: 'Example: http://user:pass@host:port',
    savedProxy: 'Saved proxy, last chars:',
    proxySaved: 'Proxy saved',
    proxyMissing: 'No proxy added',
    keySaved: 'Key saved',
    keyMissing: 'No key added yet',
    keyOptional: 'Key is optional for Local TEI',
    clear: 'Clear',
    clearProxy: 'Clear proxy',
    loading: 'Loading settings',
    ready: 'Ready to save',
    saving: 'Saving and checking...',
    saved: 'Saved',
    save: 'Save settings',
    loadError: 'Could not load settings',
    saveError: 'Could not save settings',
    validationChanged: 'Changes pending, save to check',
    validationValid: 'Key works',
    validationInvalid: 'Key does not work',
    validationSkipped: 'Check skipped',
    validationUnchecked: 'Not checked',
  },
} as const

const providerDescription = {
  ru: {
    openai: 'Генерация ответа и embeddings для облачного режима.',
    mistral: 'OCR для сканов, PDF и изображений.',
    cohere: 'Облачный reranking найденных чанков перед ответом.',
    voyage: 'Облачный reranker для качественного portfolio demo.',
    jina: 'Облачный multilingual reranker с длинным контекстом.',
    tei: 'Локальный self-hosted reranker через Hugging Face TEI.',
    qdrant: 'Vector store для dense и hybrid search.',
  },
  en: {
    openai: 'Answer generation and embeddings for cloud mode.',
    mistral: 'OCR for scans, PDFs, and images.',
    cohere: 'Cloud reranking for retrieved chunks before answer generation.',
    voyage: 'Cloud reranker for a polished portfolio demo.',
    jina: 'Cloud multilingual reranker with long-context support.',
    tei: 'Local self-hosted reranker through Hugging Face TEI.',
    qdrant: 'Vector store for dense and hybrid search.',
  },
} as const

function changedValidation(message: string): ServiceSettings['validation'] {
  return {
    status: 'unchecked',
    message,
  }
}

function validationLabel(status: ServiceSettings['validation']['status'], language: Language) {
  const text = settingsText[language]

  switch (status) {
    case 'valid':
      return text.validationValid
    case 'invalid':
      return text.validationInvalid
    case 'skipped':
      return text.validationSkipped
    case 'unchecked':
      return text.validationUnchecked
  }
}

const workspaceText = {
  ru: {
    overviewTitle: 'Рабочая область',
    overviewSubtitle: 'Личный demo-контур агента: аккаунт, настройки API и ваши загруженные документы.',
    documentsTitle: 'Документы',
    askTitle: 'Вопрос по документам',
    sourcesTitle: 'Источники',
    pipelineTitle: 'Pipeline',
    compareTitle: 'Сравнение режимов',
    noDocuments: 'Документов пока нет',
    noDocumentsText: 'Загрузите файл, чтобы он появился в этой сессии.',
    uploadReady: 'Готово к загрузке',
    uploadLoading: 'Загружаем список',
    uploading: 'Загружаем файлы...',
    uploaded: 'Загружен',
    failed: 'Ошибка',
    fileSaved: 'Файл сохранён',
    nextStage: 'Текст извлечён, разбит на чанки и доступен для поиска.',
    answerEmpty: 'Сначала загрузите документ.',
    answerReady: 'Задайте вопрос. Ответ будет собран по найденным чанкам из ваших документов.',
    askWorking: 'Ищу по индексированным чанкам...',
    askError: 'Не удалось получить ответ',
    rerankFallback: 'Reranker недоступен, использован локальный поиск',
    chunks: 'Чанки',
    extractedText: 'Извлечённый текст',
    reprocess: 'Обработать заново',
    uploadedFile: 'Загруженный файл',
    size: 'Размер',
    type: 'Тип',
    status: 'Статус',
    createdAt: 'Дата',
    account: 'Аккаунт',
    apiSettings: 'API настройки',
    storage: 'Хранилище',
    localMode: 'Локальный',
    portfolioMode: 'Облачный',
    documentsCount: 'Документы',
    sourcesCount: 'Источники',
    settingsCount: 'Сервисы',
  },
  en: {
    overviewTitle: 'Workspace',
    overviewSubtitle: 'Personal demo workspace: account, API settings, and your uploaded documents.',
    documentsTitle: 'Documents',
    askTitle: 'Ask documents',
    sourcesTitle: 'Sources',
    pipelineTitle: 'Pipeline',
    compareTitle: 'Mode comparison',
    noDocuments: 'No documents yet',
    noDocumentsText: 'Upload a file to make it available in this session.',
    uploadReady: 'Ready to upload',
    uploadLoading: 'Loading list',
    uploading: 'Uploading files...',
    uploaded: 'Uploaded',
    failed: 'Failed',
    fileSaved: 'File saved',
    nextStage: 'Text is extracted, chunked, and available for search.',
    answerEmpty: 'Upload a document first.',
    answerReady: 'Ask a question. The answer will be built from retrieved document chunks.',
    askWorking: 'Searching indexed chunks...',
    askError: 'Could not get answer',
    rerankFallback: 'Reranker is unavailable, local retrieval was used',
    chunks: 'Chunks',
    extractedText: 'Extracted text',
    reprocess: 'Reprocess',
    uploadedFile: 'Uploaded file',
    size: 'Size',
    type: 'Type',
    status: 'Status',
    createdAt: 'Date',
    account: 'Account',
    apiSettings: 'API settings',
    storage: 'Storage',
    localMode: 'Local',
    portfolioMode: 'Cloud',
    documentsCount: 'Documents',
    sourcesCount: 'Sources',
    settingsCount: 'Services',
  },
} as const

function App() {
  const [language, setLanguage] = useState<Language>('ru')
  const [agentMode, setAgentMode] = useState<AgentMode>(getInitialAgentMode)
  const [user, setUser] = useState<User | null>(null)
  const [authStatus, setAuthStatus] = useState<'checking' | 'guest' | 'authenticated'>('checking')
  const [documents, setDocuments] = useState<UserDocument[]>([])
  const [documentsStatus, setDocumentsStatus] = useState<DocumentsStatus>('loading')
  const [documentsError, setDocumentsError] = useState('')
  const [selectedDocumentId, setSelectedDocumentId] = useState('')
  const [activeNav, setActiveNav] = useState(0)
  const [question, setQuestion] = useState<string>(copy.ru.question)
  const [askResult, setAskResult] = useState<AskResponse | null>(null)
  const [askStatus, setAskStatus] = useState<'idle' | 'asking'>('idle')
  const [askError, setAskError] = useState('')
  const documentsPollingTimeoutRef = useRef<number | null>(null)
  const t = copy[language]

  const hasPendingDocuments = documents.some(
    (document) => document.status === 'queued' || document.status === 'processing',
  )

  const clearDocumentsPolling = useCallback(() => {
    if (documentsPollingTimeoutRef.current !== null) {
      window.clearTimeout(documentsPollingTimeoutRef.current)
      documentsPollingTimeoutRef.current = null
    }
  }, [])

  const applyDocuments = useCallback((nextDocuments: UserDocument[]) => {
    setDocuments(nextDocuments)
    setSelectedDocumentId((current) => {
      if (nextDocuments.some((document) => document.id === current)) {
        return current
      }

      return nextDocuments[0]?.id ?? ''
    })
  }, [])

  useEffect(() => {
    let active = true

    api
      .me()
      .then(({ user: currentUser }) => {
        if (!active) return
        setUser(currentUser)
        setAuthStatus('authenticated')
      })
      .catch(() => {
        if (!active) return
        setAuthStatus('guest')
        setDocumentsStatus('ready')
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!user) {
      clearDocumentsPolling()
      return
    }

    let active = true
    clearDocumentsPolling()
    setDocumentsStatus('loading')
    setDocumentsError('')

    api
      .getDocuments()
      .then(({ documents: loadedDocuments }) => {
        if (!active) return
        applyDocuments(loadedDocuments)
        setDocumentsError('')
        setDocumentsStatus('ready')
      })
      .catch((error) => {
        if (!active) return
        setDocumentsError(error instanceof Error ? error.message : 'Could not load documents')
        setDocumentsStatus('ready')
      })

    return () => {
      active = false
    }
  }, [applyDocuments, clearDocumentsPolling, user])

  useEffect(() => {
    if (authStatus !== 'authenticated' || !user || !hasPendingDocuments) {
      clearDocumentsPolling()
      return
    }

    let active = true

    const scheduleNextPoll = () => {
      if (!active) {
        return
      }

      clearDocumentsPolling()
      documentsPollingTimeoutRef.current = window.setTimeout(async () => {
        try {
          const { documents: loadedDocuments } = await api.getDocuments()
          if (!active) return

          applyDocuments(loadedDocuments)
          setDocumentsError('')

          if (loadedDocuments.some((document) => document.status === 'queued' || document.status === 'processing')) {
            scheduleNextPoll()
          } else {
            clearDocumentsPolling()
          }
        } catch {
          if (!active) return
          scheduleNextPoll()
        }
      }, 2500)
    }

    scheduleNextPoll()

    return () => {
      active = false
      clearDocumentsPolling()
    }
  }, [authStatus, clearDocumentsPolling, hasPendingDocuments, user, applyDocuments])

  const selectedDocument = useMemo(
    () => documents.find((document) => document.id === selectedDocumentId) ?? documents[0],
    [documents, selectedDocumentId],
  )

  function switchLanguage(nextLanguage: Language) {
    setLanguage(nextLanguage)
    setQuestion(copy[nextLanguage].question)
    setAskResult(null)
    setAskError('')
  }

  function switchAgentMode(nextMode: AgentMode) {
    setAgentMode(nextMode)
    window.localStorage.setItem(agentModeStorageKey, nextMode)
    setAskResult(null)
    setAskError('')
  }

  function handleAuthenticated(nextUser: User) {
    setUser(nextUser)
    setAuthStatus('authenticated')
  }

  async function handleLogout() {
    await api.logout()
    clearDocumentsPolling()
    setUser(null)
    setDocuments([])
    setDocumentsError('')
    setDocumentsStatus('ready')
    setSelectedDocumentId('')
    setAskResult(null)
    setAskError('')
    setAuthStatus('guest')
    setActiveNav(0)
  }

  async function handleUpload(files: FileList | File[] | null) {
    const incomingFiles = files ? Array.from(files) : []
    if (!incomingFiles.length) {
      return
    }

    setDocumentsStatus('uploading')
    setDocumentsError('')

    try {
      const response = await api.uploadDocuments(incomingFiles)
      setDocuments((current) => {
        const uploadedIds = new Set(response.documents.map((document) => document.id))
        return [...response.documents, ...current.filter((document) => !uploadedIds.has(document.id))]
      })
      setSelectedDocumentId(response.documents[0]?.id ?? '')
      setActiveNav(1)
    } catch (error) {
      setDocumentsError(error instanceof Error ? error.message : 'Upload failed')
    } finally {
      setDocumentsStatus('ready')
    }
  }

  async function handleProcessDocument(documentId: string) {
    setDocumentsError('')
    setDocuments((current) =>
      current.map((document) =>
        document.id === documentId
          ? {
              ...document,
              status: 'processing',
              pipeline: fallbackPipelineSteps,
              error: '',
            }
          : document,
      ),
    )

    try {
      const response = await api.processDocument(documentId)
      setDocuments((current) =>
        current.map((document) => (document.id === documentId ? response.document : document)),
      )
      setSelectedDocumentId(response.document.id)
    } catch (error) {
      setDocumentsError(error instanceof Error ? error.message : 'Processing failed')
    }
  }

  async function handleAsk() {
    const trimmedQuestion = question.trim()
    if (!trimmedQuestion) {
      return
    }

    setAskStatus('asking')
    setAskError('')

    try {
      const response = await api.ask(trimmedQuestion, agentMode)
      setAskResult(response)
    } catch (error) {
      setAskError(error instanceof Error ? error.message : workspaceText[language].askError)
    } finally {
      setAskStatus('idle')
    }
  }

  function renderWorkspace() {
    switch (activeNav) {
      case 0:
        return (
          <OverviewPage
            agentMode={agentMode}
            documents={documents}
            language={language}
            onOpenDocuments={() => setActiveNav(1)}
            onOpenSettings={() => setActiveNav(6)}
          />
        )
      case 1:
        return (
          <section className="content-grid" aria-label={workspaceText[language].documentsTitle}>
            <DocumentsPanel
              documents={documents}
              error={documentsError}
              language={language}
              selectedDocumentId={selectedDocumentId}
              status={documentsStatus}
              onSelectDocument={setSelectedDocumentId}
              onUpload={handleUpload}
            />
            <ProcessingPanel document={selectedDocument} language={language} onProcessDocument={handleProcessDocument} />
            <AnswerPanel
              askError={askError}
              askResult={askResult}
              askStatus={askStatus}
              documents={documents}
              language={language}
              question={question}
              onAsk={handleAsk}
              onQuestionChange={setQuestion}
            />
            <CompareStrip language={language} />
          </section>
        )
      case 2:
        return (
          <section className="workspace-page">
            <PageHeader agentMode={agentMode} language={language} title={workspaceText[language].askTitle} />
            <div className="single-panel-layout">
              <AnswerPanel
                askError={askError}
                askResult={askResult}
                askStatus={askStatus}
                documents={documents}
                language={language}
                question={question}
                onAsk={handleAsk}
                onQuestionChange={setQuestion}
              />
            </div>
          </section>
        )
      case 3:
        return <SourcesPage agentMode={agentMode} documents={documents} language={language} onUpload={handleUpload} />
      case 4:
        return (
          <section className="workspace-page">
            <PageHeader agentMode={agentMode} language={language} title={workspaceText[language].pipelineTitle} />
            <div className="single-panel-layout">
              <ProcessingPanel document={selectedDocument} language={language} onProcessDocument={handleProcessDocument} />
            </div>
          </section>
        )
      case 5:
        return <ComparePage agentMode={agentMode} language={language} />
      case 6:
        return <SettingsPage agentMode={agentMode} language={language} user={user as User} />
      default:
        return null
    }
  }

  if (authStatus === 'checking') {
    return <LoadingScreen language={language} onLanguageChange={switchLanguage} />
  }

  if (!user) {
    return <AuthScreen language={language} onAuthenticated={handleAuthenticated} onLanguageChange={switchLanguage} />
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-group">
          <button className="icon-button" type="button" aria-label="Menu">
            <Menu size={19} />
          </button>
          <div className="brand-mark">
            <Bot size={19} />
          </div>
          <span className="brand-title">{t.appTitle}</span>
        </div>

        <div className="topbar-actions">
          <AgentModeSwitch agentMode={agentMode} language={language} onAgentModeChange={switchAgentMode} />
          <LanguageSwitch language={language} onLanguageChange={switchLanguage} />
          <button className="profile-select" type="button">
            <Sparkles size={17} />
            <span>{user.name}</span>
            <ChevronDown size={15} />
          </button>
          <button className="icon-button logout-button" type="button" aria-label="Logout" onClick={handleLogout}>
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <nav aria-label="Primary">
            {t.nav.map((item, index) => {
              const Icon = navIcons[index]
              return (
                <button
                  key={item}
                  className={activeNav === index ? 'nav-item active' : 'nav-item'}
                  type="button"
                  onClick={() => setActiveNav(index)}
                >
                  <Icon size={18} />
                  <span>{item}</span>
                  {index === 5 && <small>{t.compareNew}</small>}
                </button>
              )
            })}
          </nav>
          <button className="collapse-button" type="button">
            <ChevronDown size={16} />
            Collapse
          </button>
        </aside>

        {renderWorkspace()}
      </div>
    </main>
  )
}

function LoadingScreen({
  language,
  onLanguageChange,
}: {
  language: Language
  onLanguageChange: (language: Language) => void
}) {
  return (
    <main className="auth-shell">
      <div className="auth-topbar">
        <div className="brand-group">
          <div className="brand-mark">
            <Bot size={19} />
          </div>
          <span className="brand-title">RAG OCR Knowledge Agent</span>
        </div>
        <LanguageSwitch language={language} onLanguageChange={onLanguageChange} />
      </div>
      <section className="auth-card loading-card">
        <div className="loading-pulse">
          <Bot size={24} />
        </div>
      </section>
    </main>
  )
}

function AuthScreen({
  language,
  onLanguageChange,
  onAuthenticated,
}: {
  language: Language
  onLanguageChange: (language: Language) => void
  onAuthenticated: (user: User) => void
}) {
  const [mode, setMode] = useState<'register' | 'login'>('register')
  const [name, setName] = useState('Demo User')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const text = authText[language]

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setIsSubmitting(true)

    try {
      const response =
        mode === 'register'
          ? await api.register({ name, email, password })
          : await api.login({ email, password })
      onAuthenticated(response.user)
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : text.genericError)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-topbar">
        <div className="brand-group">
          <div className="brand-mark">
            <Bot size={19} />
          </div>
          <span className="brand-title">RAG OCR Knowledge Agent</span>
        </div>
        <LanguageSwitch language={language} onLanguageChange={onLanguageChange} />
      </div>

      <section className="auth-card">
        <div className="auth-copy">
          <span className="auth-icon">
            <Lock size={22} />
          </span>
          <h1>{mode === 'register' ? text.registerTitle : text.loginTitle}</h1>
          <p>{text.subtitle}</p>
        </div>

        <div className="auth-mode-switch">
          <button className={mode === 'register' ? 'active' : ''} type="button" onClick={() => setMode('register')}>
            {text.register}
          </button>
          <button className={mode === 'login' ? 'active' : ''} type="button" onClick={() => setMode('login')}>
            {text.login}
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          {mode === 'register' && (
            <label>
              {text.name}
              <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
            </label>
          )}
          <label>
            {text.email}
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              autoComplete="email"
              required
            />
          </label>
          <label>
            {text.password}
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              minLength={8}
              required
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button auth-submit" type="submit" disabled={isSubmitting}>
            <KeyRound size={17} />
            {isSubmitting ? text.submitting : mode === 'register' ? text.createAccount : text.enter}
          </button>
        </form>
      </section>
    </main>
  )
}

function LanguageSwitch({
  language,
  onLanguageChange,
}: {
  language: Language
  onLanguageChange: (language: Language) => void
}) {
  return (
    <div className="language-switch" aria-label="Language">
      {(['ru', 'en'] as const).map((item) => (
        <button
          key={item}
          className={language === item ? 'active' : ''}
          type="button"
          onClick={() => onLanguageChange(item)}
        >
          {item.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

function AgentModeSwitch({
  agentMode,
  language,
  onAgentModeChange,
}: {
  agentMode: AgentMode
  language: Language
  onAgentModeChange: (mode: AgentMode) => void
}) {
  const text = workspaceText[language]

  return (
    <div className="agent-mode-switch" aria-label="Agent mode">
      <button
        className={agentMode === 'cloud' ? 'active' : ''}
        type="button"
        onClick={() => onAgentModeChange('cloud')}
      >
        <Sparkles size={15} />
        {text.portfolioMode}
      </button>
      <button
        className={agentMode === 'local' ? 'active' : ''}
        type="button"
        onClick={() => onAgentModeChange('local')}
      >
        <Database size={15} />
        {text.localMode}
      </button>
    </div>
  )
}

function PageHeader({ agentMode, language, title }: { agentMode: AgentMode; language: Language; title: string }) {
  const text = workspaceText[language]

  return (
    <div className="page-header">
      <span className="profile-pill">
        {agentMode === 'cloud' ? <Sparkles size={15} /> : <Database size={15} />}
        {agentMode === 'cloud' ? text.portfolioMode : text.localMode}
      </span>
      <h1>{title}</h1>
    </div>
  )
}

function OverviewPage({
  agentMode,
  documents,
  language,
  onOpenDocuments,
  onOpenSettings,
}: {
  agentMode: AgentMode
  documents: UserDocument[]
  language: Language
  onOpenDocuments: () => void
  onOpenSettings: () => void
}) {
  const text = workspaceText[language]
  const modeLabel = agentMode === 'cloud' ? text.portfolioMode : text.localMode
  const readyDocuments = documents.filter((document) => document.status === 'ready').length
  const totalChunks = documents.reduce((total, document) => total + document.chunkCount, 0)
  const latestDocument = documents[0]

  return (
    <section className="workspace-page">
      <div className="overview-hero">
        <div>
          <span className="profile-pill">
            {agentMode === 'cloud' ? <Sparkles size={15} /> : <Database size={15} />}
            {modeLabel}
          </span>
          <h1>{text.overviewTitle}</h1>
          <p>{text.overviewSubtitle}</p>
        </div>
        <div className="overview-actions">
          <button className="primary-button" type="button" onClick={onOpenDocuments}>
            <Upload size={17} />
            {copy[language].upload}
          </button>
          <button className="secondary-button" type="button" onClick={onOpenSettings}>
            <KeyRound size={17} />
            {text.apiSettings}
          </button>
        </div>
      </div>

      <div className="overview-grid">
        <OverviewTile icon={ClipboardList} label={text.documentsCount} value={String(documents.length)} />
        <OverviewTile icon={Layers3} label={text.sourcesCount} value={String(totalChunks)} />
        <OverviewTile icon={KeyRound} label={text.settingsCount} value="7" />
        <OverviewTile icon={Database} label={text.storage} value={`${readyDocuments}/${documents.length || 0}`} />
      </div>

      <div className="overview-panels">
        <section className="overview-panel">
          <h2>{text.documentsTitle}</h2>
          {documents.length ? (
            <div className="source-list compact-list">
              {documents.slice(0, 4).map((document) => (
                <SourceItem key={document.id} document={document} language={language} />
              ))}
            </div>
          ) : (
            <EmptyState language={language} onUpload={onOpenDocuments} />
          )}
        </section>
        <section className="overview-panel">
          <h2>{text.pipelineTitle}</h2>
          <PipelineSteps document={latestDocument} language={language} />
        </section>
      </div>
    </section>
  )
}

function OverviewTile({
  icon: Icon,
  label,
  value,
}: {
  icon: IconComponent
  label: string
  value: string
}) {
  return (
    <article className="overview-tile">
      <span>
        <Icon size={18} />
      </span>
      <div>
        <strong>{value}</strong>
        <small>{label}</small>
      </div>
    </article>
  )
}

function SettingsPage({ agentMode, language, user }: { agentMode: AgentMode; language: Language; user: User }) {
  const text = settingsText[language]
  const workspace = workspaceText[language]
  const [services, setServices] = useState<EditableServiceSettings[]>([])
  const [proxy, setProxy] = useState<EditableProxySettings>(() => toEditableProxy({ hasProxy: false, proxyLast4: '' }))
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'saved'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setStatus('loading')
    setError('')

    api
      .getServices()
      .then(({ services: loadedServices, proxy: loadedProxy }) => {
        if (!active) return
        setServices(loadedServices.map(toEditableService))
        setProxy(toEditableProxy(loadedProxy))
        setStatus('ready')
      })
      .catch((settingsError) => {
        if (!active) return
        setError(settingsError instanceof Error ? settingsError.message : text.loadError)
        setStatus('ready')
      })

    return () => {
      active = false
    }
  }, [text.loadError])

  function updateService(provider: ServiceSettings['provider'], patch: Partial<EditableServiceSettings>) {
    const shouldResetValidation = [
      'enabled',
      'baseUrl',
      'model',
      'apiKey',
      'clearApiKey',
    ].some((key) => key in patch)

    setServices((current) =>
      current.map((service) =>
        service.provider === provider
          ? {
              ...service,
              ...patch,
              validation: shouldResetValidation
                ? changedValidation(text.validationChanged)
                : service.validation,
            }
          : service,
      ),
    )
  }

  function selectReranker(provider: RerankerProvider) {
    setServices((current) =>
      current.map((service) =>
        isRerankerProvider(service.provider)
          ? {
              ...service,
              enabled: service.provider === provider,
              validation: changedValidation(text.validationChanged),
            }
          : service,
      ),
    )
  }

  function updateProxy(patch: Partial<EditableProxySettings>) {
    setProxy((current) => ({ ...current, ...patch }))
    setServices((current) =>
      current.map((service) =>
        proxyAppliesToProvider(service.provider)
          ? {
              ...service,
              validation: changedValidation(text.validationChanged),
            }
          : service,
      ),
    )
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setStatus('saving')

    try {
      const response = await api.saveServices(services, proxy)
      setServices(response.services.map(toEditableService))
      setProxy(toEditableProxy(response.proxy))
      setStatus('saved')
      window.setTimeout(() => setStatus('ready'), 1600)
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : text.saveError)
      setStatus('ready')
    }
  }

  const rerankerServices = services.filter(
    (service): service is EditableServiceSettings & { provider: RerankerProvider } =>
      isRerankerProvider(service.provider),
  )
  const activeRerankerProvider = rerankerServices.find((service) => service.enabled)?.provider ?? 'cohere'

  return (
    <section className="settings-page">
      <div className="settings-hero">
        <div>
          <span className="profile-pill">
            {agentMode === 'cloud' ? <Sparkles size={15} /> : <Database size={15} />}
            {agentMode === 'cloud' ? workspace.portfolioMode : workspace.localMode}
          </span>
          <h1>{text.title}</h1>
          <p>{text.subtitle}</p>
        </div>
        <div className="account-card">
          <span>{text.account}</span>
          <strong>{user.name}</strong>
          <small>{user.email}</small>
        </div>
      </div>

      <form className="settings-form" onSubmit={handleSave}>
        <article className="settings-reranker-card">
          <header>
            <span className="service-icon">
              <Search size={18} />
            </span>
            <div>
              <h2>{text.rerankerProvider}</h2>
              <small>{text.rerankerSubtitle}</small>
            </div>
          </header>

          <div className="reranker-options" role="radiogroup" aria-label={text.rerankerProvider}>
            {rerankerServices.map((service) => (
              <button
                key={service.provider}
                aria-checked={activeRerankerProvider === service.provider}
                className={activeRerankerProvider === service.provider ? 'reranker-option active' : 'reranker-option'}
                role="radio"
                type="button"
                onClick={() => selectReranker(service.provider)}
              >
                <strong>{service.label}</strong>
                <span>{service.model}</span>
              </button>
            ))}
          </div>
        </article>

        <article className="settings-proxy-card">
          <header>
            <span className="service-icon">
              <ShieldCheck size={18} />
            </span>
            <div>
              <h2>{text.proxyTitle}</h2>
              <small>{text.proxySubtitle}</small>
            </div>
          </header>

          <label className="field">
            {text.proxyUrl}
            <input
              value={proxy.proxyUrl}
              placeholder={proxy.hasProxy ? `${text.savedProxy} ${proxy.proxyLast4}` : text.proxyUrlPlaceholder}
              type="password"
              onChange={(event) =>
                updateProxy({
                  proxyUrl: event.target.value,
                  clearProxy: false,
                })
              }
            />
          </label>

          <footer>
            <div className="settings-status-stack">
              <span>{proxy.hasProxy ? text.proxySaved : text.proxyMissing}</span>
              <small>{text.proxyAppliedTo}</small>
            </div>
            {proxy.hasProxy && (
              <button
                className="text-button"
                type="button"
                onClick={() =>
                  updateProxy({
                    clearProxy: true,
                    proxyUrl: '',
                    hasProxy: false,
                  })
                }
              >
                {text.clearProxy}
              </button>
            )}
          </footer>
        </article>

        <div className="settings-grid">
          {services.map((service) => (
            <article key={service.provider} className="settings-card">
              <header>
                <span className="service-icon">
                  <KeyRound size={18} />
                </span>
                <div>
                  <h2>{service.label}</h2>
                  <small>{providerDescription[language][service.provider]}</small>
                </div>
                {isRerankerProvider(service.provider) ? (
                  <span className={service.enabled ? 'service-state selected' : 'service-state'}>
                    {service.enabled ? text.selectedReranker : text.availableReranker}
                  </span>
                ) : (
                  <label className="toggle">
                    <input
                      checked={service.enabled}
                      type="checkbox"
                      onChange={(event) => updateService(service.provider, { enabled: event.target.checked })}
                    />
                    <span />
                  </label>
                )}
              </header>

              <label className="field">
                {text.baseUrl}
                <input
                  value={service.baseUrl}
                  onChange={(event) => updateService(service.provider, { baseUrl: event.target.value })}
                />
              </label>
              <label className="field">
                {text.model}
                <input
                  value={service.model}
                  onChange={(event) => updateService(service.provider, { model: event.target.value })}
                />
              </label>
              <label className="field">
                {serviceRequiresApiKey(service.provider) ? text.apiKey : text.apiKeyOptional}
                <input
                  value={service.apiKey}
                  placeholder={service.hasApiKey ? `${text.savedKey} ${service.apiKeyLast4}` : text.apiKeyPlaceholder}
                  type="password"
                  onChange={(event) =>
                    updateService(service.provider, {
                      apiKey: event.target.value,
                      clearApiKey: false,
                    })
                  }
                />
              </label>

              <footer>
                <div className="settings-status-stack">
                  <span>
                    {service.hasApiKey
                      ? text.keySaved
                      : serviceRequiresApiKey(service.provider)
                        ? text.keyMissing
                        : text.keyOptional}
                  </span>
                  <span className={`validation-pill ${service.validation.status}`}>
                    {validationLabel(service.validation.status, language)}
                  </span>
                  {service.validation.message && <small>{service.validation.message}</small>}
                </div>
                <div className="settings-footer-actions">
                  {service.hasApiKey && (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() =>
                        updateService(service.provider, {
                          clearApiKey: true,
                          apiKey: '',
                          hasApiKey: false,
                        })
                      }
                    >
                      {text.clear}
                    </button>
                  )}
                </div>
              </footer>
            </article>
          ))}
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="settings-actions">
          <span>
            {status === 'loading'
              ? text.loading
              : status === 'saving'
                ? text.saving
                : status === 'saved'
                  ? text.saved
                  : text.ready}
          </span>
          <button className="primary-button" type="submit" disabled={status === 'loading' || status === 'saving'}>
            <Save size={17} />
            {status === 'saving' ? text.saving : text.save}
          </button>
        </div>
      </form>
    </section>
  )
}

function toEditableService(service: ServiceSettings): EditableServiceSettings {
  return {
    ...service,
    validation: service.validation ?? {
      status: 'unchecked',
      message: 'Not checked yet',
    },
    apiKey: '',
    clearApiKey: false,
  }
}

function toEditableProxy(proxy: ProxySettings): EditableProxySettings {
  return {
    hasProxy: proxy.hasProxy ?? false,
    proxyLast4: proxy.proxyLast4 ?? '',
    updatedAt: proxy.updatedAt,
    proxyUrl: '',
    clearProxy: false,
  }
}

function DocumentsPanel({
  documents,
  error,
  language,
  selectedDocumentId,
  status,
  onSelectDocument,
  onUpload,
}: {
  documents: UserDocument[]
  error: string
  language: Language
  selectedDocumentId: string
  status: DocumentsStatus
  onSelectDocument: (documentId: string) => void
  onUpload: (files: FileList | null) => void
}) {
  const t = copy[language]
  const text = workspaceText[language]
  const inputRef = useRef<HTMLInputElement | null>(null)

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    onUpload(event.target.files)
    event.currentTarget.value = ''
  }

  return (
    <section className="panel documents-panel">
      <div className="panel-heading">
        <h1>{t.documents}</h1>
        <button
          className="primary-button"
          type="button"
          disabled={status === 'uploading'}
          onClick={() => inputRef.current?.click()}
        >
          <Upload size={17} />
          {status === 'uploading' ? text.uploading : t.upload}
        </button>
        <input
          ref={inputRef}
          className="upload-input"
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md,.csv"
          onChange={handleFileChange}
        />
      </div>

      <label className="search-box">
        <Search size={17} />
        <input aria-label={t.search} placeholder={t.search} />
      </label>

      {error && <p className="form-error">{error}</p>}

      {status === 'loading' ? (
        <div className="empty-state compact">
          <CloudUpload size={22} />
          <strong>{text.uploadLoading}</strong>
        </div>
      ) : documents.length ? (
        <div className="document-table" role="list">
          {documents.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              language={language}
              selected={document.id === selectedDocumentId}
              onSelect={() => onSelectDocument(document.id)}
            />
          ))}
        </div>
      ) : (
        <EmptyState language={language} onUpload={() => inputRef.current?.click()} />
      )}

      <div className="panel-footer">
        <span>{documents.length} documents</span>
        <CloudUpload size={17} />
      </div>
    </section>
  )
}

function EmptyState({
  language,
  onUpload,
}: {
  language: Language
  onUpload: () => void
}) {
  const text = workspaceText[language]

  return (
    <div className="empty-state">
      <FileText size={24} />
      <strong>{text.noDocuments}</strong>
      <p>{text.noDocumentsText}</p>
      <button className="secondary-button" type="button" onClick={onUpload}>
        <Upload size={16} />
        {copy[language].upload}
      </button>
    </div>
  )
}

function DocumentRow({
  document,
  language,
  selected,
  onSelect,
}: {
  document: UserDocument
  language: Language
  selected: boolean
  onSelect: () => void
}) {
  const fileType = normalizeFileType(document.fileType)
  const Icon = fileIcons[fileType] ?? FileText
  const text = workspaceText[language]

  return (
    <button
      className={selected ? 'document-row selected' : 'document-row'}
      type="button"
      onClick={onSelect}
      role="listitem"
    >
      <span className={`file-chip ${fileType.toLowerCase()}`}>
        <Icon size={18} />
      </span>
      <span className="document-main">
        <strong>{document.name}</strong>
        <span>
          {fileType} · {formatBytes(document.sizeBytes)} · {document.chunkCount} {text.chunks.toLowerCase()}
        </span>
      </span>
      <span className={`status-chip ${statusTone[document.status]}`}>{statusLabel(document.status, language)}</span>
      <MoreHorizontal size={18} className="row-menu" />
    </button>
  )
}

function PipelineSteps({ document, language }: { document?: UserDocument; language: Language }) {
  const steps = document?.pipeline?.length ? document.pipeline : fallbackPipelineSteps

  return (
    <div className="pipeline-steps overview-pipeline">
      {steps.map((step, index) => {
        const stateClass = step.status === 'running' ? 'active' : step.status
        return (
          <div key={step.id} className={`pipeline-step ${stateClass}`}>
            <span className="step-index">{step.status === 'complete' ? <Check size={16} /> : index + 1}</span>
            <strong>{pipelineStepText[language][step.id]}</strong>
            <small>{pipelineStatusLabel(step, language)}</small>
          </div>
        )
      })}
    </div>
  )
}

function ProcessingPanel({
  language,
  document,
  onProcessDocument,
}: {
  language: Language
  document?: UserDocument
  onProcessDocument: (documentId: string) => void
}) {
  const t = copy[language]
  const text = workspaceText[language]

  return (
    <section className="panel processing-panel">
      <div className="panel-heading compact">
        <h2>{t.pipeline}</h2>
        {document && document.status !== 'ready' && (
          <button className="secondary-button compact-action" type="button" onClick={() => onProcessDocument(document.id)}>
            <CircleDot size={15} />
            {text.reprocess}
          </button>
        )}
      </div>

      <PipelineSteps document={document} language={language} />

      {document ? (
        <article className="document-preview">
          <div className="preview-header">
            <div>
              <strong>{document.name}</strong>
              <span className={`status-chip ${statusTone[document.status]}`}>
                {statusLabel(document.status, language)}
              </span>
            </div>
            <div className="preview-tabs">
              <button className="active" type="button">
                {t.preview}
              </button>
              <button type="button">{t.textOcr}</button>
              <button type="button">{t.metadata}</button>
            </div>
          </div>

          <div className="preview-toolbar">
            <span>
              <FileText size={16} />
              {text.fileSaved}
            </span>
            <span>{formatBytes(document.sizeBytes)}</span>
            <span>{normalizeFileType(document.fileType)}</span>
          </div>

          <div className="paper-preview uploaded-preview">
            <span className="paper-source">{text.uploadedFile}</span>
            <h3>{document.name}</h3>
            <p>{document.error || document.textPreview || text.nextStage}</p>
            <div className="metadata-grid">
              <span>{text.type}</span>
              <strong>{normalizeFileType(document.fileType)}</strong>
              <span>{text.size}</span>
              <strong>{formatBytes(document.sizeBytes)}</strong>
              <span>{text.chunks}</span>
              <strong>{document.chunkCount}</strong>
              <span>{text.status}</span>
              <strong>{statusLabel(document.status, language)}</strong>
              <span>{text.createdAt}</span>
              <strong>{formatDate(document.createdAt, language)}</strong>
            </div>
          </div>
        </article>
      ) : (
        <div className="document-preview">
          <EmptyState language={language} onUpload={() => undefined} />
        </div>
      )}
    </section>
  )
}

function AnswerPanel({
  askError,
  askResult,
  askStatus,
  language,
  question,
  documents,
  onAsk,
  onQuestionChange,
}: {
  askError: string
  askResult: AskResponse | null
  askStatus: 'idle' | 'asking'
  language: Language
  question: string
  documents: UserDocument[]
  onAsk: () => void
  onQuestionChange: (value: string) => void
}) {
  const t = copy[language]
  const text = workspaceText[language]
  const readyDocuments = documents.filter((document) => document.status === 'ready' && document.chunkCount > 0)
  const hasReadyDocuments = readyDocuments.length > 0
  const answerText = askStatus === 'asking' ? text.askWorking : askResult?.answer || (hasReadyDocuments ? text.answerReady : text.answerEmpty)
  const citations = askResult?.citations ?? []

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onAsk()
  }

  return (
    <section className="panel answer-panel">
      <div className="panel-heading compact">
        <h2>{t.ask}</h2>
        <Languages size={18} />
      </div>

      <div className="chat-stack">
        <div className="question-bubble">
          <p>{question || t.question}</p>
          <span>10:24 AM <Check size={14} /></span>
        </div>

        <div className="answer-card">
          <p>{answerText}</p>
          <footer>
            <span>10:24 AM</span>
            <span>{hasReadyDocuments ? `${citations.length} ${t.citations.toLowerCase()}` : text.noDocuments}</span>
          </footer>
        </div>
        {askResult?.warning && (
          <p className="answer-warning">
            {text.rerankFallback}: {askResult.warning}
          </p>
        )}
      </div>

      {askError && <p className="form-error">{askError}</p>}

      <h3 className="section-title">{t.citations}</h3>
      {citations.length ? (
        <div className="citations-list">
          {citations.map((citation, index) => (
            <article key={citation.id} className={index === 0 ? 'citation-card selected' : 'citation-card'}>
              <span className="citation-index">{index + 1}</span>
              <div>
                <strong>{citation.documentName}</strong>
                <small>
                  {text.chunks}: {citation.chunkIndex + 1} · score {citation.score.toFixed(1)}
                </small>
                <p>{citation.text}</p>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state compact">
          <FileText size={22} />
          <strong>{hasReadyDocuments ? t.citations : text.noDocuments}</strong>
        </div>
      )}

      <form className="ask-input" onSubmit={handleSubmit}>
        <Paperclip size={18} />
        <input
          value={question}
          onChange={(event) => onQuestionChange(event.target.value)}
          aria-label={t.input}
          placeholder={hasReadyDocuments ? t.input : text.answerEmpty}
        />
        <button className="send-button" type="submit" aria-label="Send" disabled={!hasReadyDocuments || askStatus === 'asking'}>
          <SendHorizontal size={18} />
        </button>
      </form>
    </section>
  )
}

function SourcesPage({
  agentMode,
  documents,
  language,
  onUpload,
}: {
  agentMode: AgentMode
  documents: UserDocument[]
  language: Language
  onUpload: (files: FileList | null) => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    onUpload(event.target.files)
    event.currentTarget.value = ''
  }

  return (
    <section className="workspace-page">
      <PageHeader agentMode={agentMode} language={language} title={workspaceText[language].sourcesTitle} />
      <input
        ref={inputRef}
        className="upload-input"
        type="file"
        multiple
        accept=".pdf,.docx,.txt,.md,.csv"
        onChange={handleFileChange}
      />
      {documents.length ? (
        <div className="source-list">
          {documents.map((document) => (
            <SourceItem key={document.id} document={document} language={language} />
          ))}
        </div>
      ) : (
        <EmptyState language={language} onUpload={() => inputRef.current?.click()} />
      )}
    </section>
  )
}

function SourceItem({ document, language }: { document: UserDocument; language: Language }) {
  const text = workspaceText[language]
  const fileType = normalizeFileType(document.fileType)
  const Icon = fileIcons[fileType] ?? FileText

  return (
    <article className="source-item">
      <span className={`file-chip ${fileType.toLowerCase()}`}>
        <Icon size={18} />
      </span>
      <div>
        <strong>{document.name}</strong>
        <small>
          {text.size}: {formatBytes(document.sizeBytes)} · {text.chunks}: {document.chunkCount} · {text.status}:{' '}
          {statusLabel(document.status, language)}
        </small>
      </div>
    </article>
  )
}

function ComparePage({ agentMode, language }: { agentMode: AgentMode; language: Language }) {
  const text = workspaceText[language]

  return (
    <section className="workspace-page">
      <PageHeader agentMode={agentMode} language={language} title={text.compareTitle} />
      <div className="compare-page-grid">
        <article className="mode-card">
          <span className="server-icon">
            <Sparkles size={22} />
          </span>
          <h2>{text.portfolioMode}</h2>
          <p>{copy[language].adapters}</p>
        </article>
        <article className="mode-card">
          <span className="server-icon">
            <Database size={22} />
          </span>
          <h2>{text.localMode}</h2>
          <p>{copy[language].localText}</p>
        </article>
      </div>
      <CompareStrip language={language} />
    </section>
  )
}

function CompareStrip({ language }: { language: Language }) {
  const t = copy[language]

  return (
    <section className="compare-strip">
      <div className="server-icon">
        <Database size={24} />
      </div>
      <div>
        <h2>{t.localTitle}</h2>
        <p>{t.localText}</p>
      </div>
      <ul>
        <li>
          <ShieldCheck size={17} />
          {t.privateData}
        </li>
        <li>
          <Workflow size={17} />
          {t.adapters}
        </li>
        <li>
          <Check size={17} />
          {t.noAuth}
        </li>
      </ul>
      <button className="secondary-button" type="button">
        <SplitSquareHorizontal size={17} />
        {t.compare}
      </button>
    </section>
  )
}

function normalizeFileType(fileType: string) {
  return fileType.trim().toUpperCase() || 'FILE'
}

function statusLabel(status: UserDocument['status'], language: Language) {
  if (status === 'uploaded') {
    return workspaceText[language].uploaded
  }

  if (status === 'failed') {
    return workspaceText[language].failed
  }

  return copy[language][status]
}

function pipelineStatusLabel(step: PipelineStep, language: Language) {
  if (step.message) {
    return step.message
  }

  if (step.status === 'running') {
    return copy[language].inProgress
  }

  if (step.status === 'complete') {
    return copy[language].complete
  }

  if (step.status === 'failed') {
    return workspaceText[language].failed
  }

  return copy[language].pending
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

function formatDate(value: string, language: Language) {
  return new Intl.DateTimeFormat(language === 'ru' ? 'ru-RU' : 'en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value))
}

export default App
