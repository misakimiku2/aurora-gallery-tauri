# AI 服务商集成与优化 - 实现记录

**日期**: 2026-02-14  
**会话主题**: 集成 Gemini、智谱 AI 等在线服务商，优化人脸识别与 AI 分析的协同工作

---

## 一、功能概述

本次会话实现了以下核心功能：

1. **多 AI 服务商支持** - 集成 OpenAI、Google Gemini、智谱 AI 等在线服务商
2. **CORS 代理请求** - 通过 Rust 后端代理绕过浏览器跨域限制
3. **人脸识别修复** - 修复本地文件路径访问问题，支持 DataURL 格式
4. **AI 分析优化** - 关联 AI 识别人物与人脸识别结果，自动命名人脸
5. **服务商预设系统** - 提供可视化的服务商选择和模型配置界面

---

## 二、主要修改内容

### 1. 新增 AI 服务商预设系统

#### 文件: `src/types.ts`

**新增类型定义**:
- `AIServicePreset` - AI 服务商预设接口
- `AIModelOption` - AI 模型选项接口
- `AI_SERVICE_PRESETS` - 预设服务商列表常量

**支持的服务商** (共 13 个) - 2026年2月更新:

| 服务商 | Endpoint | 推荐模型 |
|--------|----------|----------|
| OpenAI | `https://api.openai.com/v1` | gpt-5.2 |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | gemini-3-pro |
| 智谱 AI | `https://open.bigmodel.cn/api/paas/v4` | glm-5 |
| 阿里云 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | qwen3-max |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | moonshot-v1-8k |
| 硅基流动 | `https://api.siliconflow.cn/v1` | glm-5 |
| Anthropic Claude | `https://api.anthropic.com/v1` | claude-opus-4.6 |
| xAI Grok | `https://api.x.ai/v1` | grok-4-vision |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai/deployments/{deployment}` | gpt-5.2 |
| OpenRouter | `https://openrouter.ai/api/v1` | claude-opus-4.6 |
| Together AI | `https://api.together.xyz/v1` | llama-4-vision |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | llama-4-vision |
| 自定义 | 用户手动输入 | 用户手动输入 |

**修改 `AIConfig` 接口**:
```typescript
export interface AIConfig {
  // ... 其他字段
  onlineServicePreset?: string; // 预设ID: 'openai' | 'gemini' | 'zhipu' | 'custom' 等
}
```

**2026年2月模型更新说明**:
- **OpenAI**: GPT-4o 已于2025年2月退役，新增 GPT-5.2 系列
- **Google Gemini**: 新增 Gemini 3 系列 (Pro/Flash/Deep Think)
- **智谱 AI**: 2026年2月11日发布 GLM-5，编程与Agent能力最强
- **阿里云**: 新增 Qwen3-Max 万亿参数模型
- **Anthropic**: 2026年2月6日发布 Claude Opus 4.6
- **xAI**: 新增 Grok 4 系列
- **Together AI/Fireworks**: 更新至 Llama 4 Vision

#### 文件: `src/components/SettingsModal.tsx`

**新增 UI 布局**:
- 左右两栏布局：左侧服务商下拉选择，右侧模型下拉选择
- 自动填充 Endpoint 和推荐模型
- 显示"获取 Key"按钮跳转到对应平台的 API Key 管理页面
- 添加"刷新"按钮获取服务商最新模型列表
- 添加"清除"按钮清除模型缓存

**交互逻辑**:
- 选择服务商后自动更新 Endpoint 和模型
- 模型列表根据服务商动态更新
- 支持自定义模型手动输入
- 切换服务商时清除错误状态和成功提示

#### 文件: `src/utils/translations.ts`

**新增翻译**:
```typescript
// 中文
aiService: 'AI 服务商',
selectService: '选择服务商...',
fetchModels: '获取最新模型列表',
refreshModels: '刷新',
fetchingModels: '获取中...',
clearModelsCache: '清除模型缓存',
clearCache: '清除',

// 英文
aiService: 'AI Service',
selectService: 'Select Service...',
fetchModels: 'Fetch Latest Models',
refreshModels: 'Refresh',
fetchingModels: 'Fetching...',
clearModelsCache: 'Clear models cache',
clearCache: 'Clear',
```

---

### 2. 动态获取模型列表

#### 文件: `src/services/aiService.ts`

**新增 `fetchModels` 方法**:
```typescript
async fetchModels(
  presetId: string,
  apiKey: string,
  customEndpoint?: string
): Promise<{ models: AIModelOption[]; fromApi: boolean }>
```

**功能**:
- 通过 `/models` 接口获取服务商最新模型列表
- 返回模型列表和是否从 API 获取成功的标志
- 失败时返回预设模型列表作为 fallback
- 自动处理 Gemini 的 "Models/" 前缀

**新增缓存机制**:
- `getCachedModels(presetId)` - 获取本地缓存的模型列表
- `cacheModels(presetId, models)` - 缓存模型列表到 localStorage
- `clearModelsCache(presetId?)` - 清除模型缓存
- 缓存有效期 7 天

---

### 3. CORS 代理请求实现

#### 问题背景

浏览器安全策略阻止直接访问外部 API（如 Gemini、智谱 AI），报错：
```
CORS policy: Response to preflight request doesn't pass access control check
```

#### 解决方案

通过 Rust 后端代理 HTTP 请求，绕过浏览器 CORS 限制。

#### 文件: `src-tauri/src/main.rs`

**新增命令**:
```rust
#[tauri::command]
async fn proxy_http_request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>
) -> Result<String, String>
```

**功能**:
- 支持 GET/POST/PUT/DELETE 方法
- 透传请求头和请求体
- 返回响应文本

#### 文件: `src/api/tauri-bridge.ts`

**新增函数**:
```typescript
export const proxyHttpRequest = async (
  url: string,
  method: string = 'GET',
  headers: Record<string, string> = {},
  body?: string
): Promise<string>
```

#### 文件: `src/services/aiService.ts`

**修改 `callOpenAI` 方法**:
- 使用 `proxyHttpRequest` 替代 `fetch`
- 修复 URL 双斜杠问题：`endpoint.replace(/+$/, '')`

**修改 `checkConnection` 方法**:
- 使用代理请求测试连接

#### 文件: `src/hooks/useAIAnalysis.ts`

**修改 API 调用**:
- 所有 OpenAI 兼容 API 调用改为使用 `proxyHttpRequest`
- 包括图片分析、文件夹摘要等功能

---

### 4. 人脸识别功能修复

#### 问题背景

前端人脸识别库（face-api.js）无法直接访问本地文件路径：
```
Not allowed to load local resource: file:///E:/资源/xxx.jpg
```

#### 解决方案

将本地文件读取为 DataURL 后再传递给人脸识别库。

#### 文件: `src/services/faceRecognitionService.ts`

**修改方法签名**:
```typescript
// 修改前
async detectFaces(imageUrl: string)
async computeFaceDescriptor(imageUrl: string)

// 修改后
async detectFaces(imageDataUrl: string)
async computeFaceDescriptor(imageDataUrl: string)
```

**明确参数需要 DataURL 格式**。

#### 文件: `src/services/aiService.ts`

**修改 `analyzeImage` 方法**:
```typescript
// 在人脸识别前读取文件为 DataURL
const imageDataUrl = await readFileAsBase64(imagePath);
if (imageDataUrl) {
  const facesWithDescriptors = await this.detectAndRecognizeFaces(imageDataUrl, ...);
}
```

**修改 `updatePersonDescriptor` 方法**:
- 同样添加文件读取逻辑

---

### 5. AI 分析与人脸识别协同优化

#### 问题背景

AI 分析能识别出人物（如"埃隆·马斯克"），但人脸识别创建的却是"未知人物"，两者没有关联。

#### 解决方案

将 AI 分析识别出的人物名称用于命名人脸识别结果。

#### 文件: `src/hooks/useAIAnalysis.ts`

**修改人脸识别处理逻辑**:
```typescript
// 获取 AI 分析识别出的人物列表
const aiRecognizedPeople = Array.isArray(result.people) ? result.people : [];

aiData.faces.forEach((face, index) => {
  // 优先使用 AI 分析识别出的人物名称
  let personName = face.name;
  if (face.name === '未知人物' && aiRecognizedPeople.length > 0) {
    personName = aiRecognizedPeople[index] || aiRecognizedPeople[0];
    face.name = personName; // 更新显示名称
  }
  
  // 使用 personName 创建或更新人物
  // ...
});
```

**效果**:
- AI 识别出"埃隆·马斯克"
- 人脸识别自动创建"埃隆·马斯克"人物，而非"未知人物"

---

### 6. AI 描述优化

#### 问题背景

AI 描述有时不提及人物姓名，只说"一位男性"。

#### 解决方案

修改提示词，明确要求提及人物姓名。

#### 文件: `src/hooks/useAIAnalysis.ts`

**修改描述提示词**:
```typescript
// 修改前
请简简单描述这张图里的内容

// 修改后
请描述这张图里的内容。如果识别出具体人物请提及姓名。
```

**增强人物描述时**:
```
着重描述图片里的人物行为、体型，如果识别出具体人物请提及姓名。
```

---

### 7. CSP 配置更新

#### 文件: `src-tauri/tauri.conf.json`

**修改 CSP 配置**:
```json
"csp": "... connect-src 'self' ... https://open.bigmodel.cn https://generativelanguage.googleapis.com https://dashscope.aliyuncs.com https://api.moonshot.cn https://api.siliconflow.cn https://api.anthropic.com https://api.x.ai https://openrouter.ai https://api.together.xyz https://api.fireworks.ai; ..."
```

**添加的域名**:
- `https://open.bigmodel.cn` - 智谱 AI
- `https://generativelanguage.googleapis.com` - Google Gemini
- `https://dashscope.aliyuncs.com` - 阿里云
- `https://api.moonshot.cn` - 月之暗面
- `https://api.siliconflow.cn` - 硅基流动
- `https://api.anthropic.com` - Anthropic
- `https://api.x.ai` - xAI
- `https://openrouter.ai` - OpenRouter
- `https://api.together.xyz` - Together AI
- `https://api.fireworks.ai` - Fireworks AI

---

## 三、文件修改清单

### Rust 后端
- `src-tauri/src/main.rs` - 添加 `proxy_http_request` 命令
- `src-tauri/tauri.conf.json` - 更新 CSP 配置

### 前端类型与常量
- `src/types.ts` - 添加 AI 服务商预设类型和常量（13 个服务商，2026年2月更新）

### API 桥接
- `src/api/tauri-bridge.ts` - 添加 `proxyHttpRequest` 函数

### 服务层
- `src/services/aiService.ts` - 使用代理请求，修复 URL 拼接，添加动态获取模型列表功能
- `src/services/faceRecognitionService.ts` - 支持 DataURL 输入

### Hooks
- `src/hooks/useAIAnalysis.ts` - 关联 AI 识别人物与人脸识别，优化提示词

### UI 组件
- `src/components/SettingsModal.tsx` - 添加服务商预设选择界面，动态模型列表刷新

### 国际化
- `src/utils/translations.ts` - 添加中文和英文翻译

---

## 四、使用指南

### 配置在线 AI 服务商

1. **选择服务商**
   - 打开设置 → AI 智能 → 在线云端
   - 从左侧下拉框选择 AI 服务商（如 OpenAI、Gemini 等）

2. **获取 API Key**
   - 点击"获取 Key"链接，前往服务商官网申请 API Key
   - 各平台获取地址：
     - OpenAI: https://platform.openai.com/api-keys
     - Gemini: https://aistudio.google.com/app/apikey
     - 智谱 AI: https://open.bigmodel.cn/usercenter/apikeys
     - 阿里云: https://dashscope.console.aliyun.com/apiKey
     - 月之暗面: https://platform.moonshot.cn/console/api-keys
     - 硅基流动: https://cloud.siliconflow.cn/account/ak
     - Anthropic: https://console.anthropic.com/settings/keys
     - xAI: https://x.ai/api

3. **输入 API Key**
   - 将 API Key 粘贴到上方输入框

4. **（可选）刷新模型列表**
   - 点击"刷新"按钮获取该服务商最新模型列表
   - 系统会自动识别支持视觉（图像识别）的模型

5. **测试连接**
   - 点击"测试连接"验证配置是否正确

### 启用人脸识别自动命名

1. 开启"启用人脸识别"
2. 开启"自动添加到人物"
3. 进行 AI 智能分析时，人脸识别会自动使用 AI 识别出的人物名称

---

## 五、技术要点

### 1. CORS 绕过原理

```
前端 → Rust 后端代理 → API 服务器 → 返回结果
       (无 CORS 限制)
```

### 2. 人脸识别文件读取流程

```
本地路径 → readFileAsBase64() → DataURL → faceapi.fetchImage() → 正常识别
```

### 3. AI 分析与人脸识别协同流程

```
图片 → AI 分析 → 识别出人物名称（如"埃隆·马斯克"）
   ↓
图片 → 人脸识别 → 检测到人脸 → 使用 AI 识别的名称 → 创建人物
```

### 4. 动态获取模型列表流程

```
用户点击刷新
   ↓
调用 /models 接口（通过 Rust 代理）
   ↓
解析响应，过滤视觉模型，去掉前缀（如 Gemini 的 Models/）
   ↓
缓存到 localStorage
   ↓
更新下拉列表
```

---

## 六、注意事项

1. **重启应用** - 修改 Rust 代码后需要完全重启应用才能生效
2. **模型名称** - 2026年2月已更新至最新版本，包括 GPT-5.2、Gemini 3、GLM-5、Claude Opus 4.6 等
3. **Endpoint 格式** - 确保 URL 末尾没有多余斜杠
4. **API Key 安全** - API Key 存储在本地设置中，不会上传到服务器
5. **缓存清理** - 如果模型列表显示异常，可点击"清除"按钮清除缓存
6. **DeepSeek 不支持视觉** - DeepSeek 模型只能进行 OCR，不支持图像理解，已从预设中移除

---

## 七、后续优化建议

1. **更多服务商** - 可添加其他 OpenAI 兼容服务商
2. **模型列表动态获取** - ✅ 已实现
3. **人物关联优化** - 支持多个人物的关联和区分
4. **缓存机制** - ✅ 已实现模型列表缓存
5. **AI 分析结果缓存** - 缓存 AI 分析结果，避免重复请求

---