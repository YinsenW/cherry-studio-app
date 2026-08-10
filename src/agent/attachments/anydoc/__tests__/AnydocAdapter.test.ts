import type { File } from 'expo-file-system'

const mockPrepare = jest.fn()
const mockConvert = jest.fn()
const mockExtractPdfText = jest.fn()

jest.mock('../AnydocRuntimeBridge', () => ({
  anydocRuntimeBridge: {
    prepare: (...args: unknown[]) => mockPrepare(...args),
    convert: (...args: unknown[]) => mockConvert(...args)
  }
}))
jest.mock('@/modules/pdf-text-extractor', () => ({
  extractPdfText: (...args: unknown[]) => mockExtractPdfText(...args)
}))

// eslint-disable-next-line import/first
import { AnydocAdapter } from '../AnydocAdapter'

const file = {
  size: 1_024,
  uri: 'file:///private/report.pdf',
  base64: jest.fn(async () => 'ZmlsZQ==')
} as unknown as File

describe('AnydocAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPrepare.mockResolvedValue(undefined)
    mockConvert.mockResolvedValue('# Converted')
  })

  it('uses the pinned local anydoc runtime without a network service', async () => {
    await expect(new AnydocAdapter().normalize(file, '.docx')).resolves.toMatchObject({
      markdown: '# Converted',
      engine: 'anydoc-wasm',
      engineVersion: '0.1.7'
    })
    expect(mockConvert).toHaveBeenCalledWith({ base64: 'ZmlsZQ==', extension: 'docx' })
  })

  it('uses the existing native PDF extractor only when the anydoc runtime is unavailable', async () => {
    mockPrepare.mockRejectedValue(new Error('The local anydoc runtime is not mounted.'))
    mockExtractPdfText.mockResolvedValue({
      text: 'PDF fallback',
      totalPages: 2,
      extractedPages: 2,
      isTruncated: false,
      extractionError: false
    })

    await expect(new AnydocAdapter().normalize(file, '.pdf')).resolves.toMatchObject({
      markdown: 'PDF fallback',
      engine: 'pdf-native-fallback'
    })
  })

  it('does not bypass anydoc encrypted/resource errors with a weaker fallback', async () => {
    const error = Object.assign(new Error('Document is encrypted'), { code: 'encrypted' })
    mockConvert.mockRejectedValue(error)

    await expect(new AnydocAdapter().normalize(file, '.pdf')).rejects.toBe(error)
    expect(mockExtractPdfText).not.toHaveBeenCalled()
  })
})
