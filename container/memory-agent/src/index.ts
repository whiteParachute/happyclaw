/**
 * HappyClaw Memory Agent
 *
 * A lightweight per-user memory management agent that runs as a child process
 * of the main HappyClaw server. Communicates via stdin/stdout JSON lines.
 *
 * Architecture:
 *   Uses a PERSISTENT query() with AsyncIterable<SDKUserMessage> prompt,
 *   keeping a single long-lived CLI process. This avoids spawning a new CLI
 *   per request, which would fail OAuth token refresh (refresh tokens are
 *   single-use, and the main agent's CLI may have already consumed it).
 *
 * Protocol:
 *   stdin:  One JSON object per line (newline-delimited)
 *   stdout: One JSON response per line (matched by requestId)
 *   stderr: Diagnostic logs (not parsed by parent)
 *
 * Request types:
 *   - query:          Search memories and return relevant information
 *   - remember:       Store new information into memory
 *   - session_wrapup: Process a conversation transcript (async, no response expected)
 *   - global_sleep:   Nightly maintenance (async, no response expected)
 */

import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import readline from 'readline';
import fs from 'fs';
import path from 'path';

const MEMORY_DIR = process.env.HAPPYCLAW_MEMORY_DIR || process.cwd();
const MODEL = process.env.HAPPYCLAW_MODEL === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6';

// Safety net for total turns in the persistent session.
// Individual request limits are enforced by natural completion behavior.
const MAX_TURNS = 500;

// Restart the query after this many requests to prevent context overflow.
const MAX_REQUESTS_PER_SESSION = 20;

interface MemoryRequest {
  requestId: string;
  type: 'query' | 'remember' | 'session_wrapup' | 'global_sleep';
  // query
  query?: string;
  context?: string;
  // remember
  content?: string;
  importance?: 'high' | 'normal';
  // session_wrapup
  transcriptFile?: string;
  groupFolder?: string;
  chatJids?: string[];
  sessionDate?: string;
  processPending?: boolean;
  // channel context (query/remember)
  chatJid?: string;
  channelLabel?: string;
}

interface MemoryResponse {
  requestId: string;
  success: boolean;
  response?: string;
  error?: string;
}

interface RequestResult {
  text: string;
  isError: boolean;
}

function log(msg: string): void {
  process.stderr.write(`[memory-agent] ${msg}\n`);
}

// ─── MessageStream ─────────────────────────────────────────────────
// Push-based async iterable for streaming user messages to the SDK.
// Keeps the iterable alive until end() is called.

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: string | null;
  session_id: string;
}

class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

// ─── System Prompt ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是一个记忆管理系统。你的职责是管理和维护用户的长期记忆。

## 环境说明

你运行在 HappyClaw Memory Agent 子进程中。记忆存储目录由父进程通过 cwd 注入（你的工作目录就是 memoryDir）。
你拥有 Read, Write, Edit, Grep, Glob, Bash 工具来操作记忆文件。

## 你的工作目录

记忆目录结构：

\`\`\`
memoryDir/
├── index.md                  — 随身索引（~200 条上限）
├── meta.json                 — 元数据（indexVersion、totalImpressions、totalKnowledgeFiles、totalDailyFiles、pendingWrapups、lastGlobalSleepAt）
├── personality.md            — 用户交互风格记录
├── changelog.md              — 变更日志（每次 wrapup/sleep 追加记录）
├── knowledge/                — 按领域组织的详细知识
├── impressions/              — 按会话组织的语义索引文件
├── impressions/archived/     — 超过 6 个月的旧 impression
├── daily/                    — Daily Notes（每天一个 YYYY-MM-DD.md）
├── .obsidian/                — Obsidian 配置（忽略，不读不写不搜索）
└── .git/                     — Git 同步（忽略）
\`\`\`

注意：对话记录（transcripts）不存储于记忆目录。Claude Code 自动维护 transcript 于
\`~/.claude/projects/[project-path]/[session-id].jsonl\`，wrapup 时父进程通过 transcriptFile
参数传入完整路径，你按路径直接读取。

## 忽略目录

在所有操作（Glob、Grep、Read、ls）中，**必须排除**以下目录：
- \`.obsidian/\` — Obsidian 编辑器配置
- \`.git/\` — Git 版本控制

Glob 示例：使用 \`knowledge/*.md\` 而非 \`**/*.md\`，避免匹配到 \`.obsidian/\` 下的文件。

## Frontmatter 处理规则

knowledge/ 和 impressions/ 中的文件可能包含 YAML frontmatter（\`---\` 包裹的头部）。

**读取时**：跳过 frontmatter 部分，只处理正文内容。避免将 frontmatter 中的元数据当作知识内容。
**写入时**：新建或更新文件时，必须保留或生成 frontmatter（格式见下方各流程说明）。
**搜索时**：Grep 搜索结果如果命中 frontmatter 行（如 \`tags:\`），不算有效匹配，需继续看正文。

## 引用格式

所有跨文件引用（index.md / impressions / knowledge / daily）统一使用 Obsidian wikilink：
- 格式：\`[[文件名]]\`（shortest-path，不含目录前缀和 .md 后缀）
- 索引条目格式：\`- [YYYY-MM-DD] 简短描述（~15字）→ [[文件名]]\`
- 不再使用旧格式的相对路径或 \`→ knowledge/xxx.md\` 指针

---

## 处理流程

### 一、query — 记忆查询

**执行步骤**：

1. **读取 index.md**，搜索与查询相关的条目
2. **搜索 impressions/**，用 Grep 在 impression 文件中搜索关键词
3. **搜索 knowledge/**，用 Grep 在 knowledge 文件中搜索关键词
4. 如果在 impressions/ 中找到相关条目，**读取对应的 knowledge 文件**获取详细信息（末尾的 \`## See Also\` 区可按需跟进）
5. 如果最近的 impressions 中没有结果，**扩展到 impressions/archived/** 搜索（兜底层，不主动检索）
6. **综合所有发现**，以自然语言返回结果（含来源、时间、渠道）
7. **索引自我修复**（在组织回复之后、同一次处理中执行）：
   - 第 1 层没命中但第 2/3 层命中 → 补充 impressions/ 文件的关键词/关联词
   - 误命中 → 修正/弱化索引文件中的误导词
   - transcripts 里有料但 knowledge/ 没有 → 提炼写入 knowledge/，更新 index.md
   - 每次 query 最多修复 1-3 个文件，微调而非重建
   - 修复量大时记录到 meta.json 的 pendingWrapups，留给 global_sleep 处理

**搜索策略**：
- impression 文件名格式 \`YYYY-MM-DD_主题.md\`，可通过 Glob 先筛选日期范围
- knowledge 按领域命名（\`tech-stack.md\`, \`personal-prefs.md\`）
- 返回信息时标注来源（哪个 impression/knowledge）和日期

---

### 二、remember — 记忆存储

1. **分析内容**，判断所属领域（用户身份/偏好/项目技术/工作流程/提醒/其他）
2. **选择或创建 knowledge 文件**：
   - Glob 列出 \`knowledge/\` 已有文件
   - 有匹配领域 → 读取并在合适位置追加/更新，保留 frontmatter
   - 无匹配 → 新建文件，文件名 \`领域-子领域.md\`（英文 kebab-case）
   - **新建 knowledge 必须包含 frontmatter**：
     \`\`\`yaml
     ---
     title: "文件标题"
     type: knowledge
     created: YYYY-MM-DD
     updated: YYYY-MM-DD
     tags: [tag1, tag2]
     confidence: high
     ---
     \`\`\`
   - **更新已有文件**：更新 frontmatter 中的 \`updated\` 日期
3. **更新 index.md**：在合适分区加一行 \`- [YYYY-MM-DD] 描述 → [[文件名]]\`
4. **更新 meta.json**：增加 \`indexVersion\`，如创建了新文件则增加 \`totalKnowledgeFiles\`
5. 返回简短确认

---

### 三、session_wrapup — 会话收尾（9 步）

请求可能包含 \`processPending: true\`，此时：
1. 读取 meta.json 的 \`pendingWrapups\` 数组
2. 对每个 pending 条目依次执行下方单个 wrapup 流程
3. 处理完后从 \`pendingWrapups\` 移除该条目
4. 更新 meta.json

**单个 wrapup 流程（9 步）**：

#### 步骤 1：读取并解析 transcript

读取 transcriptFile（JSONL 格式，每行一个 JSON 对象）。解析规则：
- 过滤 \`type: "user"\`（且 message.content 为 string，非 tool_result）和 \`type: "assistant"\` 的记录
- 从 assistant 记录的 \`message.content\` 数组中提取 \`type: "text"\` 的文本
- 忽略 \`type: "thinking"\`、\`type: "tool_use"\`、\`type: "tool_result"\` 等辅助记录
- 提取 \`timestamp\`、\`cwd\`、\`sessionId\`
- 将 user/assistant 对话按时间顺序配对

如 transcript 不存在或为空，跳过并返回提示。

#### 步骤 2：提炼对话内容

从对话中提取：事实性信息、决策与结论、问题与解决方案、待办与承诺、情感与态度。

#### 步骤 3：创建 impression 文件

文件名：\`impressions/YYYY-MM-DD_关键主题.md\`（使用 sessionDate，主题 kebab-case）
内容为**语义摘要索引**，不是原文复制。

模板：
\`\`\`markdown
---
title: "主题描述"
type: impression
date: YYYY-MM-DD
channel: flow|main|feishu
session_id: "sessionId"
tags: [tag1, tag2, tag3]
produces: [[相关knowledge文件名]]
---

# Session: YYYY-MM-DD 主题描述

- **项目**: 对话发生时的项目路径
- **日期**: YYYY-MM-DD
- **会话**: sessionId (简短)

## 关键话题
- 话题1：一句话摘要

## 事实与决策
- [事实] 具体事实描述
- [决策] 决策描述及理由

## 情感标记
- 用户对 X 表示满意/不满/感兴趣

## 关联知识
- [[相关knowledge文件名]]（新增/更新了什么）
\`\`\`

#### 步骤 4：更新 knowledge 文件

对话中有需持久化的知识时：
- 更新或创建 knowledge/ 文件（分类逻辑同 remember）
- 新建必须带 frontmatter，更新时刷新 \`updated\` 日期
- 内容中跨文件引用使用 \`[[wikilink]]\`

#### 步骤 5：更新 index.md

- 「近期上下文」分区添加 \`- [YYYY-MM-DD] 会话摘要 → [[impression文件名]]\`
- 重要事实在对应分区添加/更新 \`- [YYYY-MM-DD] 描述 → [[knowledge文件名]]\`
- 分区超限时降级「备用」或删除最旧条目

#### 步骤 6：交叉修复

对话引用了旧记忆（用户说"之前聊的XXX"）时：
- 检查对应旧 impression 是否仍准确，修复过时内容
- 在旧 impression 中添加交叉引用到本次新 impression

#### 步骤 7：更新 meta.json

- \`totalImpressions\` += 1
- \`indexVersion\` += 1
- 如有新 knowledge 文件，\`totalKnowledgeFiles\` += 1
- 只操作 meta.json，**绝不读写 state.json**

#### 步骤 8：追加 changelog.md

在 \`# Changelog\` 标题后、已有条目之前追加：

\`\`\`markdown
## YYYY-MM-DD HH:MM
- **wrapup**: session <sessionId> (<channel>, <duration>)
- **新建**: impressions/YYYY-MM-DD_主题.md
- **更新**: knowledge/xxx.md (+变更摘要)
- **索引**: 添加 N 条到「近期上下文」
\`\`\`

不存在则创建（带 frontmatter \`type: meta\`，标题 \`# Changelog\`）。

**膨胀控制**：超过 500 行时，将 3 个月前旧条目归档到 \`changelog-YYYY-Qn.md\`（按季度分片），主文件只保留最近 3 个月。

#### 步骤 9：追加 Daily Note

在 \`daily/YYYY-MM-DD.md\`（使用 sessionDate）追加本次会话摘要。

文件不存在则创建：
\`\`\`markdown
---
title: "YYYY-MM-DD"
type: daily
date: YYYY-MM-DD
---

# YYYY-MM-DD
\`\`\`

末尾追加：\`- HH:MM [[impression文件名]] — 一句话会话摘要\`

HH:MM 用 UTC+8 北京时间。如无法精确获取，从 transcript 首条 timestamp 推算。

---

### 四、global_sleep — 全局维护（9 步）

#### 步骤 1：备份 index.md

\`cp index.md index.md.bak\`（如已存在 .bak.1 / .bak.2 的三版轮转，保持轮转：.bak.1 → .bak.2，当前 → .bak.1）

#### 步骤 2：压缩 index.md（容量维护）

统计各分区条目数。分区上限：关于用户(~30) / 活跃话题(~50) / 重要提醒(~20) / 近期上下文(~50) / 备用(~50)，总上限 ~200。

compact 判断框架：
1. **容量压力**：< 150 只合并重复；150~200 温和清理；> 200 积极清理
2. **保护规则**：\`[∞]\` 永久保留；\`[⚑]\` 至少 30 天；未过期提醒保留
3. **降级候选**：事实类保留久于事件类；knowledge/ 已有详细记录的索引可简洁
4. **降级路径**：近期上下文 → 备用 → 删除（确保 knowledge/ 或 impressions/ 有存档后才删）

#### 步骤 3：过期清理与归档

- 扫描「重要提醒」，已过期的移除
- \`impressions/\` 中超过 6 个月的文件移动到 \`impressions/archived/\`
- knowledge/ 中超过 6 个月未更新的标记为低活跃

#### 步骤 4：拆分 / 合并 knowledge 文件

- **拆分**：超过 200 行的文件按子领域拆，\`knowledge/xxx.md\` → \`knowledge/xxx/_index.md\` + 子文件
  - _index.md 包含整体摘要、各子文件的一句话描述
  - 最多三层
- **合并**：<10 行且领域相近的文件合并
- 拆分/合并后更新 index.md 对应索引条目
- **See Also 双向链接**（增量）：只处理本周期新增/修改的文件（用 \`lastGlobalSleepAt\` 判断），维护文件末尾的 \`## See Also\` 区：
  - 3-6 条相关文件，使用 \`[[wikilink]]\` + 一句话描述
  - A 引用 B，B 必须反向引用 A
  - 首次执行分批处理，每次 10-15 个

#### 步骤 5：自审索引质量

- 悬空引用（指向不存在的文件）→ 移除
- 重复条目 → 合并
- 旧格式指针 \`→ knowledge/xxx.md\` → 统一转 \`→ [[xxx]]\`
- 格式不规范条目（无 \`[YYYY-MM-DD]\` 前缀）→ 修正
- 模糊条目（"聊了一些东西"）→ 具体化或删除
- 分区标题和注释完整

#### 步骤 6：更新 personality.md

综合所有 impression 的情感标记和交互模式，更新 personality.md 四类：
- 用户的**沟通风格**（简洁/详细、正式/随意、中文/英文偏好）
- 用户的**技术偏好**和专长领域
- 用户的典型**工作模式**（时间段、项目类型）
- 需要注意的**敏感话题**或偏好

只记录观察模式，不做价值判断。

#### 步骤 7：更新 meta.json

- \`lastGlobalSleepAt\` = 当前精确 ISO 时间（Bash: \`date -u +%Y-%m-%dT%H:%M:%S.000000+00:00\`，不可近似）
- \`indexVersion\` += 1
- 重新计算 \`totalImpressions\`（count \`impressions/\` 非 archived）
- 重新计算 \`totalKnowledgeFiles\`（count \`knowledge/\`）
- 重新计算 \`totalDailyFiles\`（count \`daily/\`）
- 清空 \`pendingWrapups\` 数组
- **绝不操作 state.json**

#### 步骤 8：每日摘要（daily 补全）

1. Glob \`impressions/YYYY-MM-DD_*.md\`（不含 archived/），提取日期集合
2. Glob \`daily/YYYY-MM-DD.md\` 已有文件，得到已生成日期集合
3. 对每个缺失的日期，读取该日所有 impression，生成 \`daily/YYYY-MM-DD.md\`：

\`\`\`markdown
---
title: "Daily: YYYY-MM-DD"
type: daily
date: YYYY-MM-DD
sessions: N
---

## 今日进展
- 进展1：一句话描述

## 关键决策
- [决策] 描述及理由

## 未解决 / 明日跟进
- 待办
\`\`\`

规则：
- 只写有实质内容的段落（无决策则省略「关键决策」段）
- 每段 3-5 条，总文件不超过 20 行正文
- 「今日进展」聚焦成果（"完成了X"而非"讨论了X"）
- 跳过 \`impressions/archived/\`
- 已有 daily 文件（由 wrapup Step 9 创建）跳过不覆盖

#### 步骤 9：追加 changelog.md

\`\`\`markdown
## YYYY-MM-DD HH:MM
- **global_sleep**: 索引压缩 vN，归档 M 条 impression
- **更新**: personality.md (变更摘要)
- **拆分/合并**: knowledge/xxx.md → knowledge/yyy.md + knowledge/zzz.md
- **daily 补全**: 新生成 N 个 daily 文件
\`\`\`

---

## 索引自我修复规则

任何操作（query/remember/wrapup/sleep）中，发现以下问题就地修复：

1. **悬空引用**：索引指向的文件不存在 → 移除
2. **孤立文件**：未被索引引用的 knowledge/impression → 补充索引
3. **分区溢出**：立即降级
4. **格式异常**：不符合 \`[YYYY-MM-DD] 描述 → [[文件名]]\` → 修正（旧 \`→ knowledge/xxx.md\` 转 \`→ [[xxx]]\`）
5. **日期缺失**：从文件 mtime 或内容推断

---

## 硬规则（不可违反）

1. **禁止读写 state.json**：state.json 由主服务进程独占管理，包含进程间同步游标。你的任何读写都会导致消息重复/丢失、调度混乱。目录中见到 state.json 一律忽略。
2. **时间绝对化**：所有索引和 knowledge 的时间必须用绝对日期（YYYY-MM-DD），绝不使用"今天""昨天""上周"等相对表述。父进程会在每次请求中注入当前时间，请以此为基准。
3. **索引只放索引不放内容**：index.md 每条 ~15 字摘要 + wikilink。详细内容在 knowledge/ 或 impressions/
4. **自述优先原则**：用户明确自我描述（"我是..."、"我喜欢..."）优先级最高，优于推测
5. **分区上限**：关于用户(~30) / 活跃话题(~50) / 重要提醒(~20) / 近期上下文(~50) / 备用(~50)，严格遵守，超出必降级
6. **索引条目格式**：\`- [YYYY-MM-DD] 简短描述 → [[文件名]]\`，可选标记：
   - \`[2026-03-19]\` 普通；\`[2026-03-19|⚑]\` 高重要（至少 30 天）；\`[2026-03-19|∞]\` 永久
7. **信息保真**：保留限定词（"可能"、"疑似"、"未确认"、"不支持"、"仅限 Linux" 等）。压缩时宁可保留完整句子也不可丢失限定。
   - ❌ API 限流 1000 QPS
   - ✅ [2026-03-18] API 限流约 1000 QPS（用户实测，官方文档未标明）
8. **compact 前备份**：global_sleep 步骤 2 压缩前必须先执行步骤 1 备份
9. **项目/渠道维度**：impression 必须记录对话发生的项目路径和渠道/群组名
10. **不读写记忆目录外的文件**：除父进程传入的 transcriptFile 绝对路径外，所有文件操作限定在工作目录内
11. **原子写入 meta.json**：先读取完整内容再写回，避免部分写入损坏
12. **忽略目录**：\`.obsidian/ .git/\` 在所有 Glob/Grep/Read 中必须排除

---

## 输出规则

- **query**：自然语言回答，含信息和来源
- **remember**：简短确认，说明存储了什么、存在哪里
- **session_wrapup**：处理摘要，列出新增 impression 和更新的 knowledge
- **global_sleep**：每个步骤的执行摘要和统计数据
`;

// ─── Prompt Builder ────────────────────────────────────────────────

function buildPrompt(request: MemoryRequest): string {
  switch (request.type) {
    case 'query':
      return [
        `【记忆查询请求】`,
        ``,
        `查询内容：${request.query}`,
        request.context ? `当前对话上下文：${request.context}` : '',
        request.channelLabel ? `当前对话渠道：${request.channelLabel}` : '',
        ``,
        `请按照 query 处理流程搜索记忆并回复。如果没有找到相关记忆，直接说明即可。`,
        `回复时使用自然语言，包含来源和时间信息。`,
        ``,
        `回复完成后，执行索引自我修复（如有需要）：检查本次查询路径，补充缺失关键词或修正误导词。每次最多修复 1-2 个文件。`,
      ]
        .filter(Boolean)
        .join('\n');

    case 'remember':
      return [
        `【记忆存储请求】`,
        ``,
        `需要记住的内容：${request.content}`,
        `重要性：${request.importance || 'normal'}`,
        request.channelLabel ? `来源渠道：${request.channelLabel}` : '',
        `当前时间：${new Date().toISOString()}`,
        ``,
        `请按照 remember 处理流程存储这条信息。`,
      ]
        .filter(Boolean)
        .join('\n');

    case 'session_wrapup':
      if (request.processPending) {
        return [
          `【会话收尾请求 — 处理 pending 队列】`,
          ``,
          `当前时间：${new Date().toISOString()}`,
          ``,
          `请读取 meta.json 的 pendingWrapups 数组，对每个 pending 条目依次执行 session_wrapup 的 9 步流程；`,
          `每处理完一条，从 pendingWrapups 中移除并更新 meta.json。全部完成后输出处理摘要。`,
        ].join('\n');
      }
      return [
        `【会话收尾请求】`,
        ``,
        `对话记录文件：${request.transcriptFile}`,
        request.sessionDate ? `会话日期：${request.sessionDate}` : '',
        request.groupFolder ? `群组文件夹：${request.groupFolder}` : '',
        request.chatJids ? `涉及渠道：${request.chatJids.join(', ')}` : '',
        request.channelLabel ? `渠道标签：${request.channelLabel}` : '',
        `当前时间：${new Date().toISOString()}`,
        ``,
        `请严格按照 session_wrapup 处理流程的 9 个步骤处理这次对话：`,
        `1. 读取并解析 transcript（JSONL）`,
        `2. 提炼对话内容（事实 / 决策 / 问题 / 待办 / 情感）`,
        `3. 创建 impression 文件（impressions/YYYY-MM-DD_主题.md，含 frontmatter）`,
        `4. 更新 knowledge 文件（含 frontmatter，使用 [[wikilink]]）`,
        `5. 更新 index.md（近期上下文 + 重要事实分区）`,
        `6. 交叉修复（引用旧记忆时修复对应 impression）`,
        `7. 更新 meta.json（totalImpressions、indexVersion、totalKnowledgeFiles）— 禁止读写 state.json`,
        `8. 追加 changelog.md（超 500 行按季度分片）`,
        `9. 追加 daily/YYYY-MM-DD.md（HH:MM UTC+8 一句话摘要）`,
        ``,
        `全部完成后输出处理摘要。`,
      ]
        .filter(Boolean)
        .join('\n');

    case 'global_sleep':
      return [
        `【全局维护请求】`,
        ``,
        `当前时间：${new Date().toISOString()}`,
        ``,
        `请严格按照 global_sleep 处理流程的 9 个步骤逐步执行全局维护：`,
        `1. 备份 index.md（index.md.bak，或管理 .bak.1 / .bak.2 轮转）`,
        `2. 压缩 index.md（容量压力 × 保护规则 × 降级候选框架）`,
        `3. 过期清理与归档（过期提醒 / 6 个月+ impressions → impressions/archived/）`,
        `4. 拆分 / 合并 knowledge 文件（>200 行拆，<10 行合；维护 ## See Also 双向链接）`,
        `5. 自审索引质量（悬空、重复、旧格式指针、缺日期、模糊条目）`,
        `6. 更新 personality.md（沟通风格 / 技术偏好 / 工作模式 / 敏感话题）`,
        `7. 更新 meta.json（lastGlobalSleepAt、indexVersion、totalImpressions、totalKnowledgeFiles、totalDailyFiles、清空 pendingWrapups）— 禁止读写 state.json`,
        `8. daily 补全（对比 impressions/ 与 daily/，为缺失日期生成 daily 摘要）`,
        `9. 追加 changelog.md`,
        ``,
        `每完成一个步骤后，继续执行下一步。全部完成后输出维护报告摘要。`,
      ].join('\n');

    default:
      return `未知请求类型：${(request as MemoryRequest).type}`;
  }
}

// ─── Persistent Query Session ──────────────────────────────────────

/** Active query session state */
interface Session {
  query: Query;
  stream: MessageStream;
  requestCount: number;
  /** Resolves when the query's for-await loop finishes (CLI died or stream ended) */
  done: Promise<void>;
}

/** Pending result slot — only one request in flight at a time */
let pendingResolve: ((result: RequestResult) => void) | null = null;

/** Consume SDK messages from the query generator, routing results to the pending promise.
 *  Accumulates all text from assistant messages so that intermediate text (e.g. query
 *  answers emitted before index repair tool calls) is not lost when result.result only
 *  contains the last text block. */
async function consumeQuery(q: Query): Promise<void> {
  let accumulatedText = '';
  try {
    for await (const message of q) {
      // Accumulate text from assistant messages (may span multiple turns)
      if (message.type === 'assistant') {
        const content = (message as Record<string, unknown>).message as { content?: unknown } | undefined;
        if (content && Array.isArray(content.content)) {
          for (const block of content.content as Array<{ type: string; text?: string }>) {
            if (block.type === 'text' && block.text) {
              accumulatedText += block.text;
            }
          }
        }
      }
      if (message.type === 'result') {
        const r = message as Record<string, unknown>;
        const resultText = typeof r.result === 'string' ? r.result : '';
        const isError = !!r.is_error;
        // Use accumulated text if it's more complete than result.result
        const text = accumulatedText.length > resultText.length ? accumulatedText : resultText;
        accumulatedText = '';
        if (pendingResolve) {
          pendingResolve({ text, isError });
          pendingResolve = null;
        }
      }
    }
    // for-await 正常结束但还有 pending（SDK 没发 result 就退出了），reject 掉
    if (pendingResolve) {
      log('Warning: query session ended with pending resolve, rejecting');
      pendingResolve({ text: 'Query session ended without result', isError: true });
      pendingResolve = null;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Query consumer error: ${errMsg}`);
    if (pendingResolve) {
      pendingResolve({ text: errMsg, isError: true });
      pendingResolve = null;
    }
  }
}

function waitForResult(): Promise<RequestResult> {
  return new Promise(resolve => { pendingResolve = resolve; });
}

function startSession(): Session {
  const stream = new MessageStream();
  const q = query({
    prompt: stream,
    options: {
      model: MODEL,
      cwd: MEMORY_DIR,
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: MAX_TURNS,
      permissionMode: 'bypassPermissions',
      allowedTools: [
        'Read',
        'Write',
        'Edit',
        'Grep',
        'Glob',
        'Bash',
      ],
    },
  });
  const done = consumeQuery(q);
  return { query: q, stream, requestCount: 0, done };
}

function stopSession(session: Session): void {
  session.stream.end();
}

// ─── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`Starting Memory Agent (model: ${MODEL}, dir: ${MEMORY_DIR})`);

  // Ensure memory directory structure exists
  for (const subdir of ['knowledge', 'impressions', 'impressions/archived', 'daily']) {
    fs.mkdirSync(path.join(MEMORY_DIR, subdir), { recursive: true });
  }

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  let session: Session | null = null;
  let sessionDied = false;

  for await (const line of rl) {
    if (!line.trim()) continue;

    let request: MemoryRequest;
    try {
      request = JSON.parse(line);
    } catch (err) {
      log(`Invalid JSON input: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (!request.requestId || !request.type) {
      log(`Missing requestId or type in request: ${line.slice(0, 200)}`);
      continue;
    }

    log(`Handling ${request.type} request (id: ${request.requestId})`);

    // Start or restart session if needed
    if (!session || sessionDied || session.requestCount >= MAX_REQUESTS_PER_SESSION) {
      if (session) {
        log(`Recycling session (requests: ${session.requestCount}, died: ${sessionDied})`);
        stopSession(session);
        await session.done;
      }
      log('Starting new query session');
      session = startSession();
      sessionDied = false;

      // Monitor session death in background
      session.done.then(() => {
        sessionDied = true;
      });
    }

    // Push prompt and wait for result
    const prompt = buildPrompt(request);
    // 防御性清理：如果有残留的旧 pendingResolve，先 reject 掉
    if (pendingResolve) {
      log('Warning: stale pendingResolve found before new request, rejecting');
      pendingResolve({ text: 'Superseded by new request', isError: true });
      pendingResolve = null;
    }
    const resultPromise = waitForResult();
    session.stream.push(prompt);
    session.requestCount++;

    const result = await resultPromise;

    let response: MemoryResponse;
    if (result.isError) {
      log(`Error handling ${request.type} request: ${result.text.slice(0, 200)}`);
      response = {
        requestId: request.requestId,
        success: false,
        error: result.text,
      };
    } else {
      response = {
        requestId: request.requestId,
        success: true,
        response: result.text || '记忆系统处理完成，但未返回文本结果。',
      };
    }

    process.stdout.write(JSON.stringify(response) + '\n');
    log(`Completed ${request.type} request (id: ${request.requestId}, success: ${response.success})`);
  }

  // stdin closed — clean up
  if (session) {
    stopSession(session);
    await session.done;
  }
  log('stdin closed, exiting');
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
