function createEventSourceResolver(originalResolveRequest, polyfillPath) {
  return (context, moduleName, platform) => {
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
