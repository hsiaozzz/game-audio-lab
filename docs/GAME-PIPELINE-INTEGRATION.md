# 接入新游戏生成管线

更新：2026-11-17。独立服务现已提供 plan → job → 编码媒体包 → 本地播放器与声音 ZIP。当前演示仍是预编写小游戏，AI Game / ArcaneGame 的生产任务没有在本仓库中改动或部署。接入只针对选择新音频流程的新游戏。

## 后端编排

在游戏代码生成前冻结同一份 GameBrief 和 GameEventContract，并保存五字段 identity。并行发起游戏生成与 POST /v1/audio/plans；收到 plan 后核对身份、必需事件、格式与预算，程序选择 acceptedItems，再提交 jobs。游戏可以先可玩，音频失败保留游戏，已就绪 SFX 先到达也能先使用。

可运行的可信后端样例见 [backend-orchestrator.mjs](../examples/backend-orchestrator.mjs)。它默认确认 required items，下载真实媒体与 manifest 到本地导出目录，并保存不含凭据的 host-job.json；恢复参数和运行命令见 [HANDOFF](HANDOFF.md)。生产应在自身数据库中保存 jobId、plan/selection 身份和游戏产物引用；此样例不替代游戏生成器。

音频方案确认无需增加玩家审批。确认内容固定后复用同一 Idempotency-Key，网络超时先查询/重放，不重复创建新请求。更改设计、格式、预算或分轨重新规划；旧 revision 迟到不能覆盖当前游戏。详细 HTTP 结构见 [API-INTERACTION](API-INTERACTION.md)。

## 前端接收与播放

浏览器 SDK 不执行作曲、DSP 或模型。生产由可信后端代理 v1 并校验项目权限，前端不持有长期 service token。下面假设 `plan/job` 由该后端返回，当前站点把 `/v1/audio/*` 代理到服务：

```js
import { createAudioServiceClient, verifyIdentity } from './audio-service-client.mjs';
import { createAudioPackagePlayer } from './audio-package-player.mjs';

const client = createAudioServiceClient({ baseUrl: location.origin });
const player = createAudioPackagePlayer({ maxVoices: 12 });
const decoder = new OfflineAudioContext(2, 48000, 48000);
let latestPackageId = null;

await client.waitForJob(job.id, {
  signal,
  onUpdate: async next => {
    verifyIdentity(gameIdentity, next.identity);
    if (next.planId !== plan.planId) throw new Error('wrong plan');
    if (!next.manifestUrl || next.packageId === latestPackageId) return;
    const bundle = await client.downloadPackage(next.manifestUrl, {
      signal,
      audioContext: decoder,
      expectedIdentity: gameIdentity,
      planId: plan.planId,
      planDigest: plan.planDigest,
      selectionDigest: next.selectionDigest,
      transferBudget: plan.delivery.maxTransferBytes,
      decodedBudget: plan.delivery.maxDecodedPcmBytes
    });
    const result = player.load(bundle);
    if (!result.accepted) throw new Error(result.reason);
    latestPackageId = next.packageId;
    // 更新生成状态；玩家可以继续玩。不要在轮询里自动 unlock。
  }
});

soundButton.onclick = async () => {
  const result = await player.unlock(); // 必须来自真实用户手势
  if (result.accepted) player.music.play('bgm.exploration');
};
// 拾取结算成功时：
player.play('item.collect', { strength: 0.8, pan: 0.2 });
```

真实浏览器能力探针应在规划前运行 `client.probeFormats({audioContext:decoder,formats:capabilities.formats})`，把 acceptedFormats 交给后端；probe 只解码短静音，不播放。若服务 renderer.ready=false，页面保留游戏并显示可重试原因。

用 onUpdate 接收部分包时，player.load 只允许相同设计/plan/selection 的新包。切游戏必须新建 player；停止轮询与播放器、关闭旧桥并释放客户端。已解码数据常驻内存，低码率不能替代 PCM 预算。页面隐藏可 player.pause，恢复由玩家控制；不应让旧尾音进入新游戏。

## opaque iframe 预览

生成游戏只得到受限 GameAudio 客户端，不拿媒体 URL、模型密钥或 AudioContext。可信装配器使用 gameAudioClientSource() 注入客户端；游戏在真实行为成立时调用：

```js
await window.GameAudio.ready;
await window.GameAudio.emit('item.collect', { strength: 0.8, pan: 0.2 });
await window.GameAudio.setScene('exploration');
await window.GameAudio.setIntensity(0.6);
```

`src/game-audio-bridge.mjs` 已实现 MessageChannel 握手、session、briefHash/revision 与递增 sequence，最初 disabled。旧 `createGameAudioAdapter()` 接受旧 Tone 渲染结果，不能直接加载媒体 bundle。新包可使用宿主自己的窄 facade；以下是可用的接线结构，保持旧桥只支持 strength/pan：

```js
import { createGameAudioBridge } from './game-audio-bridge.mjs';

const sourcePlan = plan.sourcePlan;
const scenes = new Set(sourcePlan.eventContract.sceneStates);
const events = new Set(sourcePlan.eventContract.events.map(event => event.id));
const adapter = {
  emit(id, payload = {}) {
    if (!events.has(id)) return { accepted: false, reason: 'unknown-event' };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return { accepted: false, reason: 'invalid-payload' };
    if (Object.keys(payload).some(key => !['strength', 'pan'].includes(key)))
      return { accepted: false, reason: 'unsupported-payload' };
    return player.play(id, payload);
  },
  setScene(scene) {
    return scenes.has(scene) ? player.setScene(scene)
      : { accepted: false, reason: 'unknown-scene' };
  },
  setIntensity(value) { return player.setIntensity(value); }
};
const bridge = createGameAudioBridge({ iframe, plan: sourcePlan, adapter });
await bridge.connect(); // 注入的游戏客户端已安装后调用
// 收包校验/解码与真实手势解锁完成之后：
bridge.setEnabled(true);
// 离开或切换 revision：bridge.dispose(); await player.dispose();
```

使用前宿主仍需以 validateGameAudioJoin 核对当前游戏和 plan.identity/sourcePlan。facade 是接入示例，不表示 delivery.html 已自动集成所有生成器 iframe。bridge 只提供 emit/setScene/setIntensity，不给子游戏 start/unlock/dispose 或 listener 控制权。

opaque iframe origin 为 null，不能仅信 origin。桥把端口只交当前 contentWindow，客户端核对初始 event.source===parent；后续只使用此连接。场景切换、销毁及 iframe 重建关闭旧端口。事件只传控制数据，PCM 不经每次 postMessage 复制。

生成提示应要求新任务只调用 GameAudio，避免同时生成另一套 BGM/SFX 和时钟。真实 3D 玩法要求不能因为声音只有三个风格而被降成 2D。生成器原有零外部请求和 sandbox 限制可保持，音频由宿主持有。

## Three.js / 3D 接入范围

新包播放器支持 optional HRTF-distance-panning-without-occlusion；旧桥/旧 adapter 仍 stereo-pan-only。SFX plan 中声明 spatial.enabled 后，可信宿主可以直接调用：

```js
player.setListener({
  position: { x: cameraWorld.x, y: cameraWorld.y, z: cameraWorld.z },
  forward: { x: cameraForward.x, y: cameraForward.y, z: cameraForward.z },
  up: { x: cameraUp.x, y: cameraUp.y, z: cameraUp.z }
});
player.play('weapon.fire', {
  strength: 0.8,
  position: { x: muzzleWorld.x, y: muzzleWorld.y, z: muzzleWorld.z }
});
```

统一世界坐标、长度单位、camera 世界方向与 up，不能把 localPosition 或屏幕坐标直接混用。事件 position 是单次触发的位置快照，当前没有更新持续声源位置的 handle；listener 可以持续更新。未实现射线遮挡、墙体滤波、混响区域或 Three.js 自动绑定。它是基于浏览器的播放能力，不是完整 3D 生成游戏或跨设备空间听感验收；扩展桥前需定义专门坐标/频率合同。

## 保存、独立导出与版本

`exportAudioPackageZip()` 已能导出验证过的媒体、manifest、来源/许可、最小 runtime 和静态试听页。解压后在本地 HTTP 运行，不依赖生成服务、Tone 或 token。它不是自动合并整款游戏的导出器，不保证 file:// 或单文件 HTML。

游戏打包器应把声音包与 runtime 装入本地目录，用相对路径、真实 MIME/bytes/encoding 处理二进制；不要把服务 URL、绝对路径或 base64 文本当普通 UTF-8 资源。预览/导出分别装配，但核对同一设计与 packageId。保存游戏版本记录音频 plan/selection/package 摘要，实际玩法验收要覆盖组合后的成品。

生成状态、播放锁定与质量状态分开：游戏 ready 不等于声音 ready；requiredReady 不等于 allSelectedReady；技术 passed 不等于听审 passed。音频失败保留无声可玩稿，required 缺失不得标完整声音交付。重试声音不重调用游戏模型。

## 外部生成器的历史接入点

以下为 2026-11-16 的只读代码检查定位，后续接入需在各自当前版本复核；本仓库没有修改它们：

| 项目 | 位置 | 应接入的职责 |
|---|---|---|
| AI Game | CreatorContext 的 startGeneration、directGameService 的 runDirectGamePipeline | 冻结共享身份，并行任务、保存进度和独立取消 |
| AI Game | buildDirectSystemPrompt / DIRECT_MODE_SYSTEM、GamePreviewFrame | 新任务切 GameAudio 合同，可信父宿主建桥和持有 player |
| AI Game | multiFileProject / zipWriter | 处理二进制资源、预览与导出装配 |
| ArcaneGame | server/routers.ts 的 game.generate / game.patch、server/game/freegen.ts | 在 createGameDesign 后、代码生成前冻结合同并派发声音 |
| ArcaneGame | shared/game/design.ts、bundle.ts、client/src/lib/gamePreview.ts | 保存身份、音频资源、离线装配与组合验收 |

先选择一个真实的新游戏任务完成预览、保存、重开和导出联调，再扩展类别。历史样本的通过不能直接作为生产生成器已完成接入的证明。
