import '@/i18n'
import 'react-native-reanimated'

import { db, expoDb } from '@db'
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native'
import { useMigrations } from 'drizzle-orm/expo-sqlite/migrator'
import { useDrizzleStudio } from 'expo-drizzle-studio-plugin'
import { useFonts } from 'expo-font'
import * as SplashScreen from 'expo-splash-screen'
import { HeroUINativeProvider } from 'heroui-native'
import React, { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Button, Text, View } from 'react-native'
import { SystemBars } from 'react-native-edge-to-edge'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Provider } from 'react-redux'
import { PersistGate } from 'redux-persist/integration/react'
import { Uniwind } from 'uniwind'

import { DialogManager } from '@/componentsV2'
import SheetManager from '@/componentsV2/features/Sheet/SheetManager'
import { UpdatePrompt } from '@/componentsV2/features/UpdatePrompt'
import { useTheme } from '@/hooks/useTheme'
import { loggerService } from '@/services/LoggerService'
import store, { persistor } from '@/store'

import migrations from '../drizzle/migrations'
import { ShortcutCallbackManager } from './aiCore/tools/SystemTools/ShortcutCallbackManager'
import { DialogProvider } from './hooks/useDialog'
import { ToastProvider } from './hooks/useToast'
import MainStackNavigator from './navigators/MainStackNavigator'
import { runAppDataMigrations } from './services/AppInitializationService'

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync()
const logger = loggerService.withContext('AppInitialization')

// 数据库初始化组件
function DatabaseInitializer({ children }: { children: React.ReactNode }) {
  const { success, error } = useMigrations(db, migrations)
  const [loaded] = useFonts({
    FiraCode: require('./assets/fonts/FiraCode-Regular.ttf')
  })
  const [initializationState, setInitializationState] = useState<'pending' | 'ready' | 'error'>('pending')
  const [initializationError, setInitializationError] = useState<Error | null>(null)

  useDrizzleStudio(expoDb)

  useEffect(() => {
    if (success) {
      logger.info('Database migrations completed successfully', expoDb.databasePath)
      // Initialize iOS Shortcuts callback listener
      ShortcutCallbackManager.initializeListener()
    }

    if (error) {
      logger.error('Database migrations failed', error as Error)
    }
  }, [success, error])

  const initializeApp = useCallback(async () => {
    setInitializationState('pending')
    setInitializationError(null)

    try {
      await runAppDataMigrations()
      logger.info('App data initialized successfully')
      setInitializationState('ready')
    } catch (e) {
      const initializationFailure = e instanceof Error ? e : new Error(String(e))
      logger.error('Failed to initialize app data', initializationFailure)
      setInitializationError(initializationFailure)
      setInitializationState('error')
    }
  }, [])

  useEffect(() => {
    if (success && loaded) {
      void initializeApp()
    }
  }, [success, loaded, initializeApp])

  useEffect(() => {
    if (loaded && (error || initializationState !== 'pending')) {
      void SplashScreen.hideAsync()
    }
  }, [loaded, error, initializationState])

  // 如果迁移失败，显示错误界面
  if (error || initializationState === 'error') {
    return (
      <View className="flex-1 items-center justify-center gap-4 px-6">
        <Text className="text-center text-red-500">
          {initializationError?.message || 'Database initialization failed. Please restart the app.'}
        </Text>
        {!error && <Button title="Retry" onPress={() => void initializeApp()} />}
      </View>
    )
  }

  // 如果迁移还未完成或字体未加载，显示加载指示器
  if (!success || !loaded || initializationState !== 'ready') {
    return <ActivityIndicator size="large" />
  }

  // 迁移成功且字体已加载，渲染子组件
  return <>{children}</>
}

// 主题和导航组件
function ThemedApp() {
  const { isDark } = useTheme()

  useEffect(() => {
    Uniwind.setTheme(isDark ? 'dark' : 'light')
  }, [isDark])

  return (
    <HeroUINativeProvider>
      <KeyboardProvider>
        <NavigationContainer theme={isDark ? DarkTheme : DefaultTheme}>
          <SystemBars style={isDark ? 'light' : 'dark'} />
          <DialogProvider>
            <ToastProvider>
              <MainStackNavigator />
              <SheetManager />
              <DialogManager />
              <UpdatePrompt />
            </ToastProvider>
          </DialogProvider>
        </NavigationContainer>
      </KeyboardProvider>
    </HeroUINativeProvider>
  )
}

// Redux 状态管理组件
function AppWithRedux() {
  return (
    <Provider store={store}>
      <PersistGate loading={<ActivityIndicator size="large" />} persistor={persistor}>
        <DatabaseInitializer>
          <ThemedApp />
        </DatabaseInitializer>
      </PersistGate>
    </Provider>
  )
}

// 根组件 - 只负责最基础的 Provider 设置
export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppWithRedux />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
