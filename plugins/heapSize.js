const ConfigPlugins = require('@expo/config-plugins')
module.exports = function androidManifestPlugin(config) {
  return ConfigPlugins.withAndroidManifest(config, async config => {
    const androidManifest = config.modResults.manifest
    if (androidManifest && androidManifest.application && androidManifest.application.length > 0) {
      androidManifest.application[0].$['android:largeHeap'] = 'true'
    }
    return config
  })
}
