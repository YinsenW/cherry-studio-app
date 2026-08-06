const ConfigPlugins = require('@expo/config-plugins')

module.exports = function androidThemeColorPlugin(config) {
  return ConfigPlugins.withAndroidStyles(config, async config => {
    const styles = config.modResults
    const appTheme = styles.resources?.style?.find(s => s.$.name === 'AppTheme')
    if (appTheme && appTheme.item) {
      const hasColorControlActivated = appTheme.item.some(item => item.$.name === 'colorControlActivated')
      if (!hasColorControlActivated) {
        appTheme.item.push({
          _: '#02b86b',
          $: { name: 'colorControlActivated' }
        })
      }
    }

    return config
  })
}
