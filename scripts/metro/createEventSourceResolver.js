function createEventSourceResolver(originalResolveRequest, polyfillPath, sourceModules = {}) {
  return (context, moduleName, platform) => {
    const sourceModulePath = sourceModules[moduleName]
    if (sourceModulePath) {
      return { filePath: sourceModulePath, type: 'sourceFile' }
    }
    if (moduleName === 'eventsource') {
      return { filePath: polyfillPath, type: 'sourceFile' }
    }
    if (originalResolveRequest) {
      return originalResolveRequest(context, moduleName, platform)
    }
    return context.resolveRequest(context, moduleName, platform)
  }
}

module.exports = { createEventSourceResolver }
