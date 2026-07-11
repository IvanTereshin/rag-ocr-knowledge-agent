import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const rootDir = process.cwd()
const pipelineDistPath = join(rootDir, 'apps/api/dist/pipeline.js')

if (!existsSync(pipelineDistPath)) {
  throw new Error('apps/api/dist/pipeline.js not found. Run `npm run build` first.')
}

const { processDocument, selectAnswerCandidates } = await import(`file://${pipelineDistPath}`)

const evalCases = [
  {
    fileName: 'security-policy.txt',
    fileType: 'TXT',
    mimeType: 'text/plain',
    content: [
      'Security Policy',
      '',
      'All customer documents must be processed in the local profile when the workspace is marked private.',
      'API keys are stored encrypted with APP_SECRET and are never returned to the browser.',
      'Uploads larger than the configured server limit must be rejected before parsing.',
    ].join('\n'),
    questions: [
      {
        question: 'How are API keys stored?',
        expectedDocument: 'security-policy.txt',
        expectedPhrase: 'encrypted with APP_SECRET',
      },
      {
        question: 'What should happen to oversized uploads?',
        expectedDocument: 'security-policy.txt',
        expectedPhrase: 'rejected before parsing',
      },
    ],
  },
  {
    fileName: 'pricing.csv',
    fileType: 'CSV',
    mimeType: 'text/csv',
    content: [
      'Plan,Monthly price,Included pages',
      'Starter,49,1000',
      'Business,199,10000',
      'Enterprise,Custom,Unlimited',
    ].join('\n'),
    questions: [
      {
        question: 'Which plan includes 10000 pages?',
        expectedDocument: 'pricing.csv',
        expectedPhrase: 'Business',
      },
    ],
  },
]

const tempDir = await mkdtemp(join(tmpdir(), 'rag-ocr-eval-'))

try {
  const allChunks = []
  for (const evalCase of evalCases) {
    const storagePath = join(tempDir, evalCase.fileName)
    await writeFile(storagePath, evalCase.content)
    const document = {
      id: randomUUID(),
      userId: 'eval-user',
      fileName: evalCase.fileName,
      originalName: evalCase.fileName,
      fileType: evalCase.fileType,
      mimeType: evalCase.mimeType,
      sizeBytes: Buffer.byteLength(evalCase.content),
      status: 'processing',
      storagePath,
      chunkCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const result = await processDocument(document, tempDir)
    allChunks.push(...result.chunks)
  }

  const questionCases = evalCases.flatMap((evalCase) => evalCase.questions)
  const results = questionCases.map((testCase) => {
    const ranked = selectAnswerCandidates(testCase.question, allChunks, 3)
    const top = ranked[0]
    const foundExpectedDocument = ranked.some((chunk) => chunk.documentName === testCase.expectedDocument)
    const foundExpectedPhrase = ranked.some((chunk) => chunk.text.includes(testCase.expectedPhrase))
    const hasCitationMetadata = ranked.some((chunk) => chunk.source?.fileName === testCase.expectedDocument)

    return {
      question: testCase.question,
      expectedDocument: testCase.expectedDocument,
      topDocument: top?.documentName ?? null,
      foundExpectedDocument,
      foundExpectedPhrase,
      hasCitationMetadata,
      passed: foundExpectedDocument && foundExpectedPhrase && hasCitationMetadata,
    }
  })

  const passed = results.filter((result) => result.passed).length
  const report = {
    total: results.length,
    passed,
    failed: results.length - passed,
    retrievalHitRate: results.length ? passed / results.length : 0,
    results,
  }

  console.log(JSON.stringify(report, null, 2))
  if (report.failed > 0) {
    process.exitCode = 1
  }
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
