/**
 * React Native 兼容的 eventsource / eventsource-parser stub
 *
 * @modelcontextprotocol/client v2 的根入口静态导入了 eventsource 和
 * eventsource-parser/stream，但这两个包需要全局 Event 类（Hermes 没有）
 * 和 Node HTTP 模块（RN 没有），导致 Hermes 加载时直接
 * ReferenceError: Event is not defined → 闪退。
 *
 * Cherry Studio 使用自研的 RNStreamableHTTPClientTransport（内置
 * RNEventSourceParser），不依赖这两个包的任何功能。因此安全地 stub 掉。
 */

// ---- eventsource stub ----

/** 空实现，满足 @modelcontextprotocol/client 的 import 需求 */
export class EventSource {
  static CONNECTING = 0 as const
  static OPEN = 1 as const
  static CLOSED = 2 as const

  readonly CONNECTING = EventSource.CONNECTING
  readonly OPEN = EventSource.OPEN
  readonly CLOSED = EventSource.CLOSED

  readonly readyState: number = EventSource.CLOSED
  readonly url: string

  onopen: ((ev: any) => void) | null = null
  onmessage: ((ev: any) => void) | null = null
  onerror: ((ev: any) => void) | null = null

  constructor(url: string, _eventSourceInitDict?: any) {
    this.url = url
  }

  close(): void {}
}

export default EventSource

// ---- eventsource-parser/stream stub ----

export const EventSourceParserStream = class {
  readable: ReadableStream<unknown>
  writable: WritableStream<unknown>

  constructor() {
    // 创建一个空的可写/可读流对
    const { readable, writable } = new TransformStream()
    this.readable = readable
    this.writable = writable
  }
}
