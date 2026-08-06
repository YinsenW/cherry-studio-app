# Agent 模式设计（方案 A：聊天模式）

> 目标：让 Pi agent 作为 Cherry Studio App 现有聊天的**一种运行模式**，复用全部现有基础设施，不造平行世界。

> **实现状态：已完成首版。** 发送分流在 `useMessageSend`（agentMode 偏好），工具轨迹复用 `ToolBlock` 渲染，平行世界文件（AgentScreen/usePiAgent/AgentStackNavigator/抽屉入口）已删除。

## 1. 需求定义

用户视角的 agent 模式价值：

1. 一句话描述任务 → agent **自主拆解** → **连续调用手机工具**（提醒/日历/时间/网络/快捷指令）→ 总结结果
2. 工具执行过程**可视化**（参数、状态、结果，与现有 MCP 工具块一致）
3. 中途可**中止**
4. 对话与历史**完全持久化**，与普通聊天一致

## 2. 现有基础设施（全部复用）

| 能力 | 现有组件 | 说明 |
|---|---|---|
| 模型选择 | `presentModelSheet({ mentions, setMentions })` | 全局底部选择器，返回 `Model[]` |
| Provider 数据 | `useAllProviders()` | 缓存 + CHERRYAI 兜底 |
| 消息发送 | `MessagesService.sendMessage()` → `fetchAndProcessAssistantResponseImpl()` → `OrchestrationService.transformMessagesAndFetch()` | 流式块经 `onChunkReceived(chunk)` 渲染 |
| 工具轨迹展示 | `ChunkType.MCP_TOOL_CREATED/PENDING/IN_PROGRESS/COMPLETE` + `ToolMessageBlock` + `ToolBlock.tsx` | **已存在**，无需新 UI |
| 中止 | `addAbortController(userMessageId, abort)` | 现有取消机制 |
| 持久化 | SQLite + Redux topic/messages | 沿用 |
| 工具面 | `SystemTool`（提醒/日历/时间/网络/快捷指令） | 全量 |

## 3. 架构：消息发送路径分流

```
ChatScreen（topic 驱动）
  ├─ MessageInput → 发送
  │    ├─ 普通模式：sendMessage()（现有路径，不动）
  │    └─ Agent 模式：sendAgentMessage()（新增）
  │         ├─ 保存用户消息（现有 saveMessageAndBlocksToDB）
  │         ├─ 读 topic 历史 → 转 pi Context.messages
  │         ├─ 构造 Agent（pi-agent-core）+ streamFn（现有 provider）+ 全量 SystemTool
  │         └─ agent 事件流 → 现有 ChunkType 块流 → 复用 ToolBlock 渲染 + 消息持久化
  └─ Agent 开关（ChatScreen 头部 / 输入区）
```

## 4. 核心转换：pi 事件 → 现有块流

| pi 事件 | 现有 Chunk / Block | 渲染 |
|---|---|---|
| `message_start`（user） | 已由发送端保存 | — |
| `message_update`（text_delta） | `BLOCK_IN_PROGRESS` + 文本块追加 | 现有文本块 |
| `tool_execution_start` | `MCP_TOOL_CREATED`/`IN_PROGRESS` + `ToolMessageBlock` | 现有 `ToolBlock` |
| `tool_execution_end` | `MCP_TOOL_COMPLETE` + 更新 ToolMessageBlock | 现有 `ToolBlock` |
| `message_end`（assistant） | 完整 assistant 消息 + 文本块落库 | 现有 |
| `agent_end` | `finishTopicLoading` + 话题命名 | 现有 |
| error | `ChunkType.ERROR` | 现有错误块 |

消息双向转换：
- `Message[]` → pi `Context.messages`（user/assistant/toolResult）
- pi assistant 消息（含 toolCall）→ 现有 assistant `Message` + `ToolMessageBlock`

## 5. 模型与工具

- **模型选择**：Agent 模式用同一个 `presentModelSheet`，通过 `filterFn` 过滤出 `function_calling` 能力的模型；选中结果写入 `assistant.model`（与普通模式一致）
- **工具**：`SystemTool` 全量，经 `toolAdapter.aiSdkToolToAgentTool` 转 pi `AgentTool`（已有实现，保留）
- **streamFn**：复用已有 `streamBridge.ts`（Cherry provider → pi 协议），它已通过类型检查

## 6. 中止与生命周期

- agent 循环绑定现有 `addAbortController`；中止 → `agent.abort()` → 现有取消 UI
- 话题级运行：开关开启期间，每一轮都在同一 topic 追加消息，上下文连续
- App 重启后：历史消息从 topic 还原，agent 上下文从消息重建（可续聊）

## 7. 范围与后续

**本次实现**：
- `sendAgentMessage` + pi 事件 → 现有块流的转换层
- Agent 开关 UI（ChatScreen）
- 消息双向转换（Message ↔ pi Message）
- 复用已有 `AgentService`/`streamBridge`/`toolAdapter`/`SystemTool`

**后续（不做）**：
- 权限确认 UI（`beforeToolCall` 阻塞 + 确认对话框）
- schedule 定时任务工具
- 独立 agent 会话入口

## 8. 风险

- **侵入现有发送路径**：分流点选在 `fetchAndProcessAssistantResponseImpl` 之外新增独立函数，不修改现有函数 → 普通聊天零影响
- **上下文格式转换**：`Message[]` → pi 消息的保真度（图片/引用等），首版只保文本 + 工具调用，其余类型降级为摘要
- **工具权限**：SystemTool 的写操作（创建提醒等）在首版直接执行，权限确认后置
