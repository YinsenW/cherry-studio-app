const { getDefaultConfig } = require('expo/metro-config')
const { withUniwindConfig } = require('uniwind/metro')
const { createEventSourceResolver } = require('./scripts/metro/createEventSourceResolver')
const path = require('path')

const config = getDefaultConfig(__dirname)

config.resolver.sourceExts.push('sql')
if (!config.resolver.assetExts.includes('wasm')) config.resolver.assetExts.push('wasm')

// 添加对 @cherrystudio/ai-core 的支持
config.resolver.resolverMainFields = ['react-native', 'browser', 'main']
config.resolver.platforms = ['ios', 'android', 'native', 'web']

// @modelcontextprotocol/client v2 的 eventsource 实现依赖 Hermes 不具备的
// Event / Node HTTP 能力。Cherry Studio 的 MCP 走自研 RN transport，因此只对
// eventsource 本身使用 stub。
//
// 不能拦截 eventsource-parser：AI SDK 的 Provider 流也依赖它解析 SSE。
// 把 parser 替换为透传 stub 会使 data 成为 undefined，并导致主聊天链路
// 报 "JSON parsing failed: Text: undefined"。
const POLYFILL_PATH = path.resolve(__dirname, 'src/polyfills/eventsource.ts')
// `dist` is a publish artifact and deliberately not committed. Resolve the
// workspace package to its source so a Git pull can never leave Metro using a
// stale local artifact from an earlier transport implementation.
const MCP_TRANSPORT_SOURCE_PATH = path.resolve(__dirname, 'packages/react-native-streamable-http/src/index.ts')
const originalResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = createEventSourceResolver(originalResolveRequest, POLYFILL_PATH, {
  '@cherrystudio/react-native-streamable-http': MCP_TRANSPORT_SOURCE_PATH
})

module.exports = withUniwindConfig(config, { cssEntryFile: './global.css' })
