import type { UserMessage } from '@earendil-works/pi-ai'

import { piMessagesToAiSdkMessages } from '../messageBridge'

describe('piMessagesToAiSdkMessages', () => {
  it('preserves image parts in user messages', () => {
    const message: UserMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image', data: 'aW1hZ2UtYnl0ZXM=', mimeType: 'image/png' }
      ],
      timestamp: 1
    }

    expect(piMessagesToAiSdkMessages([message])).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image.' },
          { type: 'image', image: 'aW1hZ2UtYnl0ZXM=', mediaType: 'image/png' }
        ]
      }
    ])
  })

  it('keeps remote image URLs as URLs for AI SDK providers', () => {
    const message: UserMessage = {
      role: 'user',
      content: [{ type: 'image', data: 'https://example.com/image.png', mimeType: 'image/png' }],
      timestamp: 1
    }

    const [converted] = piMessagesToAiSdkMessages([message])
    const imagePart = Array.isArray(converted.content) ? converted.content[0] : undefined

    expect(imagePart).toMatchObject({
      type: 'image',
      image: new URL('https://example.com/image.png'),
      mediaType: 'image/png'
    })
  })
})
