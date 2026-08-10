import { type FileMetadata, FileTypes } from '@/types/file'

import { buildAttachmentManifest, buildMountedAttachments } from '../AttachmentManifest'

const metadata = (id: string, name: string, size: number): FileMetadata => ({
  id,
  name,
  origin_name: name,
  path: `file:///private/uploads/${id}`,
  size,
  ext: name.slice(name.lastIndexOf('.')),
  type: FileTypes.TEXT,
  created_at: 1,
  count: 1
})

describe('AttachmentManifest', () => {
  it('keeps model context independent of attachment byte size and hides native paths', () => {
    const small = buildAttachmentManifest(buildMountedAttachments('current', [metadata('a', 'data.csv', 10)]), {
      scope: 'current',
      toolsAvailable: true
    })
    const large = buildAttachmentManifest(
      buildMountedAttachments('current', [metadata('a', 'data.csv', 200 * 1024 * 1024)]),
      { scope: 'current', toolsAvailable: true }
    )

    expect(small).not.toContain('file:///private')
    expect(large).not.toContain('file:///private')
    expect(large.length - small.length).toBeLessThan(20)
    expect(large).toContain('table_query')
  })

  it('uses the same safe collision-resistant names as the input mount', () => {
    const attachments = buildMountedAttachments('current', [
      metadata('a', '../report.csv', 1),
      metadata('b', 'report.csv', 1)
    ])

    expect(attachments.map(item => item.logicalPath)).toEqual(['current/report.csv', 'current/report-2.csv'])
  })
})
