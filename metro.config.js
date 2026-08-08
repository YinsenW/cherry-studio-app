const { getDefaultConfig } = require('expo/metro-config')
const { withUniwindConfig } = require('uniwind/metro')

const config = getDefaultConfig(__dirname)

config.resolver.sourceExts.push('sql')

// 添加对 @cherrystudio/ai-core 的支持
config.resolver.resolverMainFields = ['react-native', 'browser', 'main']
config.resolver.platforms = ['ios', 'android', 'native', 'web']

// @modelcontextprotocol/client v2 导入了 eventsource 和 eventsource-parser，
// 这两个包需要 Node Event 类（Hermes 没有）和 HTTP 模块（RN 没有），
// 导致模块加载时 ReferenceError: Event is not defined → 闪退。
// Cherry Studio 使用自研的 RNStreamableHTTPClientTransport，不依赖这两个包。
// 用 resolveRequest 拦截替换为 stub。
const POLYFILL_PATH = require('path').resolve(__dirname, 'src/polyfills/eventsource.ts')
const originalResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'eventsource' || moduleName.startsWith('eventsource-parser')) {
    return { filePath: POLYFILL_PATH, type: 'sourceFile' }
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = withUniwindConfig(config, { cssEntryFile: './global.css' })
