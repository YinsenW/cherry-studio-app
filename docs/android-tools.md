# Android 系统能力工具（agent 用）

基于 Android 14 (API 34) 的系统能力调研 + 项目已装 expo 模块，为 agent 提供可操作的手机能力。

## 调研：Android 14 上可作为 agent 工具的系统能力

| 能力域 | 系统 API / 权限 | 状态 |
|---|---|---|
| **日历事件** | `CalendarContract`（读写事件，无特殊权限） | ✅ `SystemTool.CalendarTools` 已实现 |
| **剪贴板** | `ClipboardManager`（无需权限） | ✅ `AndroidTools.Get/SetClipboardText` |
| **网络状态** | `ConnectivityManager`（`ACCESS_NETWORK_STATE`） | ✅ `AndroidTools.GetNetworkStatus` |
| **设备信息** | `Build` + `DeviceManager` | ✅ `AndroidTools.GetDeviceInfo` |
| **打开 URL/深链接** | `ACTION_VIEW` Intent | ✅ `AndroidTools.OpenUrl` |
| **系统设置页** | 各 `android.settings.*` Intent | ✅ `AndroidTools.OpenSystemSettings` |
| **沙盒文件** | app 私有存储 | ✅ `AndroidTools.ListAppDocuments` |
| **语音合成** | `TextToSpeech` | ✅ `AndroidTools.SpeakText` |
| **网页抓取** | 网络 + HTML 解析 | ✅ `SystemTool.FetchTools` |
| **时间/日期** | `System.currentTimeMillis` | ✅ `SystemTool.TimeTools` |
| **本地通知/提醒** | `NotificationManager` + `POST_NOTIFICATIONS`(13+)、`SCHEDULE_EXACT_ALARM`(精确闹钟) | ⏳ 需装 `expo-notifications` |
| **位置** | `LocationManager` + `ACCESS_FINE/COARSE_LOCATION` | ⏳ 需装 `expo-location` |
| **相册** | `MediaStore` + `READ_MEDIA_IMAGES/VIDEO`、Android 14 新增 `READ_MEDIA_VISUAL_USER_SELECTED`（部分照片访问） | ⏳ 用 `expo-media-library`（已装，待接线） |
| **电池/电量** | `BatteryManager` | ⏳ 需装 `expo-battery` |
| **屏幕亮度** | `Settings.System` 亮度 | ⏳ 需装 `expo-brightness` |
| **联系人** | `ContactsContract` + `READ_CONTACTS` | ⏳ 需装 `expo-contacts` |
| **健康数据** | Health Connect（Android 14 平台内置） | ⏳ 敏感，默认不做 |
| **凭证/通行密钥** | Credential Manager | ❌ 安全敏感，不适合 agent |

## 已实现：AndroidTools（零新增依赖）

`src/aiCore/tools/SystemTools/AndroidTools.ts`，8 个工具，全部用项目已装 expo 模块：

| 工具 | 说明 |
|---|---|
| `GetClipboardText` | 读剪贴板文本 |
| `SetClipboardText` | 写剪贴板 |
| `GetNetworkStatus` | 网络连接状态/类型 |
| `GetDeviceInfo` | 设备型号/系统/内存 |
| `OpenUrl` | 打开 https 或深链接 |
| `OpenSystemSettings` | 打开指定系统设置页（14 类） |
| `ListAppDocuments` | 列沙盒文档目录 |
| `SpeakText` | TTS 语音朗读 |

Agent 模式的工具集 = `SystemTool`（提醒/日历/时间/网络/快捷指令）+ `AndroidTool`。

## 权限说明（Android 14 关键点）

- 本次 8 个工具**均无需新增运行时权限**（剪贴板、网络状态、设备信息、Intent、沙盒文件、TTS 是免权限的）
- 日历（expo-calendar）已声明 `READ_CALENDAR/WRITE_CALENDAR`
- 后续加通知/位置/相册时需声明 `POST_NOTIFICATIONS`、`ACCESS_FINE_LOCATION`、`READ_MEDIA_*` 并在运行时请求
- Android 14 精确闹钟：`USE_EXACT_ALARM` 默认拒绝，需引导用户在设置里授权 `SCHEDULE_EXACT_ALARM`

## 下一步候选

1. `expo-notifications` —— 本地提醒/定时通知（agent 最有价值的能力，Android 上替代 iOS Reminders）
2. `expo-location` —— 位置感知工具
3. `expo-media-library` —— 相册读取（注意 Android 14 部分照片访问）
