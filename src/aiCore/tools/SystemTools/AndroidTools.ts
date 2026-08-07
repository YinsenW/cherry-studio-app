import { tool } from 'ai'
import * as Clipboard from 'expo-clipboard'
import * as Device from 'expo-device'
import * as FileSystem from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import * as IntentLauncher from 'expo-intent-launcher'
import * as Linking from 'expo-linking'
import * as MediaLibrary from 'expo-media-library'
import * as Network from 'expo-network'
import * as Speech from 'expo-speech'
import * as WebBrowser from 'expo-web-browser'
import { Platform } from 'react-native'
import Share from 'react-native-share'
import { z } from 'zod'

/**
 * Android 系统能力工具集。
 *
 * 基于 Android 14 (API 34) 上可直接触达的系统能力，全部用项目已装的
 * expo 模块实现，零新增依赖：
 * - 剪贴板（Clipboard）
 * - 网络状态（Network）
 * - 设备信息（Device）
 * - 打开 URL / 深链接（Linking / WebBrowser）
 * - 打开系统设置页（IntentLauncher）
 * - 沙盒文件浏览（FileSystem 新 API）
 * - 语音合成朗读（Speech）
 *
 * 工具与现有 SystemTool 同构（ai 的 tool + zod），agent 模式与普通聊天都可注入。
 */

export const getClipboardText = tool({
  description:
    'Read the current text content of the system clipboard. Useful to see what the user copied. Returns the clipboard text or empty string.',
  inputSchema: z.object({}),
  execute: async () => {
    const text = await Clipboard.getStringAsync()
    return { clipboard: text || '', length: text?.length ?? 0 }
  }
})

export const setClipboardText = tool({
  description: 'Copy a text string to the system clipboard so the user can paste it elsewhere.',
  inputSchema: z.object({
    text: z.string().describe('The text to copy to the clipboard')
  }),
  execute: async ({ text }) => {
    await Clipboard.setStringAsync(text)
    return { message: 'Copied to clipboard', length: text.length }
  }
})

export const getNetworkStatus = tool({
  description:
    'Get the current network status of the device: whether online, the network type (wifi/cellular) and whether the connection is expensive (metered).',
  inputSchema: z.object({}),
  execute: async () => {
    const state = await Network.getNetworkStateAsync()
    return {
      isConnected: state.isConnected ?? false,
      isInternetReachable: state.isInternetReachable ?? false,
      type: state.type
    }
  }
})

export const getDeviceInfo = tool({
  description:
    'Get basic device information: brand, model name, OS name, OS version, and whether it is running on Android.',
  inputSchema: z.object({}),
  execute: async () => {
    return {
      platform: Platform.OS,
      brand: Device.brand ?? null,
      modelName: Device.modelName ?? null,
      osName: Device.osName ?? null,
      osVersion: Device.osVersion ?? null,
      deviceName: Device.deviceName ?? null,
      supportedCpuArchitectures: Device.supportedCpuArchitectures ?? [],
      totalMemory: Device.totalMemory ?? null,
      isDevice: Device.isDevice
    }
  }
})

export const openUrl = tool({
  description:
    'Open a URL or deep link in the system (browser, another app, or an https URL). Use for https links or app deep links.',
  inputSchema: z.object({
    url: z.string().describe('The URL or deep link to open, e.g. https://example.com or myapp://page')
  }),
  execute: async ({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      await WebBrowser.openBrowserAsync(url)
    } else {
      await Linking.openURL(url)
    }
    return { message: `Opened ${url}` }
  }
})

const ANDROID_SETTINGS_ACTIONS: Record<string, string> = {
  settings: 'android.settings.SETTINGS',
  wifi: 'android.settings.WIFI_SETTINGS',
  bluetooth: 'android.settings.BLUETOOTH_SETTINGS',
  notifications: 'android.settings.APP_NOTIFICATION_SETTINGS',
  apps: 'android.settings.APPLICATION_DETAILS_SETTINGS',
  location: 'android.settings.LOCATION_SOURCE_SETTINGS',
  date: 'android.settings.DATE_SETTINGS',
  display: 'android.settings.DISPLAY_SETTINGS',
  sound: 'android.settings.SOUND_SETTINGS',
  storage: 'android.settings.INTERNAL_STORAGE_SETTINGS',
  accessibility: 'android.settings.ACCESSIBILITY_SETTINGS',
  security: 'android.settings.SECURITY_SETTINGS',
  battery: 'android.settings.BATTERY_SAVER_SETTINGS',
  storage_manager: 'android.settings.MANAGE_ALL_APPLICATIONS_SETTINGS'
}

export const openSystemSettings = tool({
  description:
    'Open an Android system settings page. Choices: settings, wifi, bluetooth, notifications, apps, location, date, display, sound, storage, accessibility, security, battery, storage_manager. Only works on Android.',
  inputSchema: z.object({
    page: z
      .enum([
        'settings',
        'wifi',
        'bluetooth',
        'notifications',
        'apps',
        'location',
        'date',
        'display',
        'sound',
        'storage',
        'accessibility',
        'security',
        'battery',
        'storage_manager'
      ])
      .describe('The system settings page to open')
  }),
  execute: async ({ page }) => {
    if (Platform.OS !== 'android') {
      return { message: 'System settings pages are only available on Android' }
    }
    const action = ANDROID_SETTINGS_ACTIONS[page] ?? ANDROID_SETTINGS_ACTIONS.settings
    await IntentLauncher.startActivityAsync(action)
    return { message: `Opened system settings: ${page}` }
  }
})

export const listAppDocuments = tool({
  description:
    'List the files and directories in the app documents directory (sandboxed storage). Returns names and types.',
  inputSchema: z.object({}),
  execute: async () => {
    const docs = FileSystem.Paths.document
    const dir = new FileSystem.Directory(docs)
    const entries = dir.list()
    return {
      directory: docs,
      entries: entries.map(entry => ({
        name: entry.name,
        type: entry instanceof FileSystem.File ? 'file' : 'directory'
      }))
    }
  }
})

export const speakText = tool({
  description:
    'Speak a text aloud using the device text-to-speech engine (on-device voice output). Useful for reading a summary aloud.',
  inputSchema: z.object({
    text: z.string().describe('The text to speak aloud')
  }),
  execute: async ({ text }) => {
    await Speech.speak(text)
    return { message: 'Speaking started' }
  }
})

export const shareText = tool({
  description:
    'Open the system share sheet with a text message, so the user can share it to other apps (messaging, social, notes...).',
  inputSchema: z.object({
    text: z.string().describe('The text content to share')
  }),
  execute: async ({ text }) => {
    await Share.open({ title: 'Cherry Studio', message: text, failOnCancel: false })
    return { message: 'Share sheet opened' }
  }
})

export const listRecentPhotos = tool({
  description:
    'List the most recent photos in the device photo library (names + taken dates). Asks for photo library permission the first time. Note: on Android 14 the user may grant partial access.',
  inputSchema: z.object({
    count: z.number().optional().describe('How many recent photos to list, default 10')
  }),
  execute: async ({ count }) => {
    const perm = await MediaLibrary.requestPermissionsAsync()
    if (!perm.granted) {
      return { ok: false, error: 'Photo library permission denied' }
    }
    const { assets } = await MediaLibrary.getAssetsAsync({
      first: count ?? 10,
      sortBy: [MediaLibrary.SortBy.creationTime],
      mediaType: MediaLibrary.MediaType.photo
    })
    return {
      ok: true,
      photos: assets.map(a => ({
        id: a.id,
        filename: a.filename,
        createdAt: new Date(a.creationTime).toISOString(),
        width: a.width,
        height: a.height,
        uri: a.uri
      }))
    }
  }
})

export const pickImage = tool({
  description:
    'Open the system photo picker so the user can select one image. Returns the image URI and metadata. Asks for permission if needed.',
  inputSchema: z.object({}),
  execute: async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      selectionLimit: 1,
      quality: 0.8
    })
    if (result.canceled || result.assets.length === 0) {
      return { ok: false, error: 'User cancelled image selection' }
    }
    const asset = result.assets[0]
    return { ok: true, uri: asset.uri, width: asset.width, height: asset.height, mimeType: asset.mimeType }
  }
})

export const takePhoto = tool({
  description: 'Open the camera so the user can take a photo. Returns the captured photo URI and metadata.',
  inputSchema: z.object({}),
  execute: async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) {
      return { ok: false, error: 'Camera permission denied' }
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.8 })
    if (result.canceled || result.assets.length === 0) {
      return { ok: false, error: 'User cancelled camera' }
    }
    const asset = result.assets[0]
    return { ok: true, uri: asset.uri, width: asset.width, height: asset.height, mimeType: asset.mimeType }
  }
})

export const AndroidTool = {
  GetClipboardText: getClipboardText,
  SetClipboardText: setClipboardText,
  GetNetworkStatus: getNetworkStatus,
  GetDeviceInfo: getDeviceInfo,
  OpenUrl: openUrl,
  OpenSystemSettings: openSystemSettings,
  ListAppDocuments: listAppDocuments,
  SpeakText: speakText,
  ShareText: shareText,
  ListRecentPhotos: listRecentPhotos,
  PickImage: pickImage,
  TakePhoto: takePhoto
}

export type AndroidToolKeys = keyof typeof AndroidTool
