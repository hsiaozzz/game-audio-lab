# 音频服务接口与交互

版本：`audio-service-v1`，2026-11-17。本文描述已实现的 `/v1/audio/*`；机器定义见 [OpenAPI](openapi.json) 与 [TypeScript 类型](audio-service-types.d.ts)。

顺序为共享设计 → 声音方案 → 宿主校验并选择交付项 → 后台渲染/编码 → 下载校验 → 游戏本地播放。方案确认是调用方的程序校验；演示页用按钮展示边界，产品不必增加逐音效人工批准步骤。默认创作仍为三类有限风格、本地 seed 作曲，不是任意提示词到成品音乐的模型。

## HTTP 入口

| 方法与路径 | 成功响应 | 行为 |
|---|---|---|
| `GET /v1/audio/health` | `200` | 依赖、导演配置、存储状态；检查缓存 10 秒 |
| `GET /v1/audio/capabilities` | `200` | 格式、风格、限制与空间音频能力 |
| `POST /v1/audio/plans` | `201 { plan }` | 保存不可变交付方案，不渲染媒体 |
| `GET /v1/audio/plans/:planId` | `200 { plan }` | 取回同 owner 的方案 |
| `POST /v1/audio/jobs` | `202 { job, replayed:false }` | 创建后台任务；幂等重放为 `200` |
| `GET /v1/audio/jobs/:id` | `200 { job }` | 进度、组件错误与当前包地址 |
| `DELETE /v1/audio/jobs/:id` | `200 { job }` | 取消未完成工作；重复调用安全 |
| `POST /v1/audio/jobs/:id/retry` | `202`，重放 `200` | 创建重试任务，复用已就绪组件 |
| `GET /v1/audio/packages/:digest/manifest` | `200` | 响应直接是不可变 manifest |
| `GET/HEAD /v1/audio/packages/:digest/files/:path` | `200/206/304` | 清单内文件，支持单段 Range、ETag |

JSON 请求使用 `Content-Type: application/json`，最大 256 KiB。创建/重试任务须带 1–256 字符的 `Idempotency-Key`；同 owner/project/key 更改请求会返回 `409 idempotency_conflict`。重复提交同一请求沿用 key；新的一次组件重试使用新 key。

配置 token 后所有 v1 入口（含 health/文件）均需 `Authorization: Bearer …`。`GAME_AUDIO_API_TOKENS_JSON` 为 owner→token 映射，资源按 owner 隔离；projectId 本身不是授权凭据。无 token 仅允许 loopback 本地开发。跨源须配置精确的 `GAME_AUDIO_ALLOWED_ORIGINS`，服务不使用 cookie。生产密钥放可信后端，不交给生成 iframe。写请求当前每 owner 每分钟最多 60 次。

## 创建方案

完整样例见 [audio-service-request.json](../examples/audio-service-request.json)。可直接提交的简化请求：

```json
{
  "gameBrief": {
    "schemaVersion": 1,
    "projectId": "island-demo",
    "revision": 1,
    "prompt": "温暖海岛收集游戏，轻柔木琴配乐与清楚的拾取反馈"
  },
  "eventContract": {
    "schemaVersion": 1,
    "version": 1,
    "sceneStates": ["exploration"],
    "events": [
      { "id": "item.collect", "cue": "collect", "required": true, "maxRatePerSecond": 6 }
    ]
  },
  "options": { "seed": 1701 },
  "audioRequests": [
    { "id": "sfx.item.collect", "kind": "sfx", "eventId": "item.collect", "required": true, "variants": 2 },
    { "id": "bgm.exploration", "kind": "music", "scene": "exploration", "required": true, "loop": true, "playback": "mix", "maxDurationSeconds": 50 }
  ],
  "delivery": {
    "profile": "compact-opus-v1",
    "acceptedFormats": ["opus-ogg", "aac-lc-m4a"],
    "selection": "one-format-per-item",
    "quality": "compact",
    "sfxQuality": "standard",
    "renderMode": "hybrid",
    "maxTransferBytes": 12582912,
    "maxDecodedPcmBytes": 67108864
  }
}
```

`prompt` 至多 10,000 字符，扩展设计字段会参与 brief 摘要。`revision` 和合同 `version` 为正整数；兼容输入 `briefRevision`，归一后为 `revision`。HTTP `options` 只接受无符号 32 位 `seed`，不接受模块路径、函数、模型地址或素材 URL。

支持 cue：`ui/collect/cast/splash/footstep/footstepWood/hit/laser/charge/explosion/victory/failure`。事件 ID 表示玩法语义，cue 表示配方。required 事件必须有 cue 与对应 SFX item；一个事件只能对应一个 SFX item。可选 `cue:null` 表示尚无映射。

省略 `audioRequests` 时，为已映射事件生成单变体 SFX；有 sceneStates 时另生成一项 required、循环的 BGM mix。显式请求可缩小范围。required 估计超预算会拒绝；可选候选总估计超预算不会阻止后续确认较小的选择，实际交付仍检查完整选择的预算。

音乐 `playback` 为 `mix`（一个立体声混音）或 `stems`（同步 core/texture/rhythm 三层，不附 mix）。同 plan 的音乐 slots 当前共享同一主题谱面，scene 元数据不会产生不同的探索/战斗作品。`maxDurationSeconds` 是上限，不是指定或剪辑时长；16 小节时长由 BPM 决定，服务上限 65 秒。

SFX 单声道、1–3 变体；`victory/failure` 仅 1，synth 的 `ui/collect/laser/charge` 也仅 1。可配置 `spatial:{enabled:true,refDistance:1,maxDistance:100,rolloffFactor:1,distanceModel:"inverse"}`，声明新包播放器的空间效果参数，不在服务端烘焙 HRTF。

方案返回 `planId/planDigest/identity/sourcePlan/items/delivery/versions/estimates/status`。`planId` 为 `plan-` 加内容 SHA-256；identity 是 `projectId/revision/briefHash/contractVersion/contractHash`；`versions` 含源码、音源和算法身份；`estimates` 是保守估计；`status:'awaiting-confirmation'` 不表示媒体已就绪。sourcePlan 是谱面合同，不是媒体包。

## 确认并创建任务

宿主先核对五字段 identity、required 覆盖、格式与预算，再提交下面的真实结构。`plan` 来自上一步，不能自行拼造摘要：

```js
const confirmation = {
  planId: plan.planId,
  planDigest: plan.planDigest,
  identity: plan.identity,
  acceptedItems: plan.items.filter(item => item.required).map(item => item.id),
  delivery: plan.delivery
};
const response = await fetch(`${audioOrigin}/v1/audio/jobs`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${serviceToken}`,
    'Idempotency-Key': confirmationKey
  },
  body: JSON.stringify(confirmation)
});
const payload = await response.json();
if (!response.ok) throw new Error(payload.error.message);
const job = payload.job;
```

`acceptedItems` 必须非空、来自方案并包含全部 required。其余字段原样回传。更改格式、预算、分轨或设计须新建 plan。确认后的受保护源码/素材改变会拒绝旧计划；升级后重新规划，不修改已保存 plan 绕过哈希。

## 进度、部分就绪与重试

任务状态：`queued → rendering → ready | partial-ready | failed | cancelled`。组件状态：`queued/rendering/ready/failed/cancelled`。`partial-ready` 是终态，至少一项成功但另有失败。生成中也可已有 package，不能只在终态下载。

`requiredReady` 表示必需项完成，`allSelectedReady` 表示已选项全部完成。没有 required 项时前者可直接为 true，宿主还须判断自身策略。响应另含 components、progress、selectionDigest、packageId、manifestUrl、filesBaseUrl 和时间戳。新增就绪组件生成新 digest 的不可变包，旧包不改写。

重试提交原 `planId/planDigest/identity/acceptedItems/delivery`，可加 `retryItems:[itemId]`；省略则选择全部符合条件的失败/取消项。仅 incomplete 终态可重试，`retryable:false` 项需修正输入或依赖并新建方案。重试创建新 job，带 retryOf，保留已完成组件；不要重做游戏。

队列落本地文件，单服务进程持锁。重启后未完成 rendering 项恢复 queued，已完成缓存校验后复用。默认并发 1，HTTP 配置最多 4；待处理最多 64 / 每 owner 16。断开轮询或取消 fetch 不会取消后台任务，须 DELETE。health 的 degraded 也返回 200，应检查 renderer.ready。

## 媒体包与本地播放

manifest 的 packageId 是除自身外整份规范 JSON 的 SHA-256。files 记录相对路径、真实长度/hash、MIME、编码器、采样率/帧/声道、trim/loop 与质量。包附 `provenance/LICENSES.txt` 和 `provenance/assets.json`。不得把机器路径或 token 写入游戏。

`requiredReady/allSelectedReady` 根据当前已发布包的 deliveredItems 计算。组件刚完成渲染而包尚未发布时，标记不会提前变为 true；progress.ready 可以先增加。宿主看到就绪标记时，可立即读取对应 manifest 和文件。

`src/audio-service-client.mjs` 提供实际解码格式探针、API、下载校验、解码、取消、重试和缓存；下载同时核对设计、plan、selection、manifest 与逐文件摘要和预算。dispose 会取消在途请求/轮询，迟到的解码结果会被丢弃。可选 IndexedDB 缓存编码字节；内存默认编码 32 MiB、解码 96 MiB。播放器/bundle 自身仍持有内存，切游戏需释放；IndexedDB 当前没有自动配额回收。

`src/audio-package-player.mjs` 播放已验证并解码的包，支持 mix/同步分轨、变体、强度、暂停恢复、静音和可选 HRTF。真实手势 unlock 后，`player.play('item.collect')` 只用本地 AudioBuffer，不调用生成服务、Tone 或模型。`setScene` 只记录状态，切曲须显式 music.play。

容器/解码器处理 AAC priming，SDK 按母版帧数裁尾；不要盲减开头 1024 帧。记录 loop 帧边界不等于所有浏览器均已通过无缝循环听审。quality 的 technical passed、binding contract-validated-gameplay-not-evaluated 与 listening not-evaluated 分别表达工程、合同与听感，不能互相替代。

## 默认媒体输出格式

| 项目 | Opus/Ogg 默认 | AAC-LC/M4A 回退 |
|---|---|---|
| BGM | 48 kHz stereo，64 kbps VBR；high 为 96 | 48 kHz stereo，96 kbps 目标码率 |
| SFX | 48 kHz mono，48 kbps VBR；compact-approved 为 32 | 48 kHz mono，64 kbps 目标码率 |

先以真实 decodeAudioData 探针取得有序 acceptedFormats，默认选第一项，可用 formatOverrides 按 item 指定。每 item 只交付一种编码；解码失败要新建格式方案，不能修改已确认包。compact-approved 表示调用方批准紧凑档的听审，服务不会自动听审。

默认传输 12 MiB、解码 Float32 PCM 64 MiB；HTTP 上限 64/256 MiB。预算计编码与 provenance 文件真实字节、实际解码帧×声道×4；不含 manifest HTTP 开销和渲染临时开销。压缩文件小不代表 PCM 小，stems 通常是 mix 三倍。WAV Float32 母版留服务缓存，运行包不带完整音源库。参见 [默认配置](../examples/audio-delivery-defaults.json)，这是说明配置，不能整体当 plan request 提交。

## 旧入口与错误

旧 `/api/audio/plan`、`/api/audio/capabilities`、pipeline.html 保留给 loopback 浏览器渲染实验。其 game-audio-plan 和 createAudioPackage(plan) 只有谱面、files 为空，不是 v1 媒体包，也不是 v1 URL 的别名。新接入用 delivery.html 与 v1。

错误结构为 `{error:{code,message,retryable,componentId?}}`。401 检查凭据，403 检查来源，409 检查摘要/身份/幂等或 stale-renderer，422 检查能力/时长/预算，429 退避，503 检查模型导演/Chromium/FFmpeg/存储。现有码同时有连字符和下划线，按返回原值处理；未知码保留 message/retryable。
