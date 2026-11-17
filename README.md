# GameAudioLab

独立的游戏声音生成与交付项目，v0.2.0，2026-11-17。同一份游戏设计可以并行驱动游戏生成和 BGM/SFX 制作，游戏通过语义事件使用已交付的本地声音。

本仓库已实现声音方案、后台离线渲染、Opus/AAC 编码、持久任务与缓存、按需媒体包、浏览器播放和声音 ZIP。默认创作只有 cozy/neon/ruins 三类有限风格与 seed 作曲；这是可集成原型，任意提示词的成品音乐质量仍需算法和听审迭代。现有游戏项目未改动，本仓库不含通用游戏生成模型。

## 启动

需要 Node.js 20.6+（推荐 22 或更新的 LTS）、FFmpeg/ffprobe（含 libopus 与 AAC 编码器）、匹配的 Playwright Chromium。首次安装：

```sh
npm ci
npx playwright install chromium
npm run doctor
npm start
```

Linux 可用 `npx playwright install --with-deps chromium` 安装系统依赖。FFmpeg/ffprobe 放 PATH，或设置 GAME_AUDIO_FFMPEG/GAME_AUDIO_FFPROBE。默认监听 `http://127.0.0.1:4178`，环境项见 [.env.example](.env.example)；`.env` 不会被 npm start 自动读取，Node 20.6+ 可用 `node --env-file=.env scripts/server.mjs`。

打开 **http://127.0.0.1:4178/delivery.html**  
建立方案、选择所需声音并确认制作，媒体下载/校验/解码后点击开启声音。小游戏可先玩，短 SFX 可先于 BGM 就绪；全部播放在本地缓冲执行。可选择 mix 或三层动态分轨，导出声音 ZIP 后在静态 HTTP 下脱离生成服务运行。

`npm run doctor` 检查存储、浏览器安装与媒体工具；health 的 renderer.ready 和实际 service:e2e 才分别覆盖运行前依赖与真实渲染链路。首次 BGM 仍需离线制作，不是即时推理。改变端口用 GAME_AUDIO_PORT；非 loopback 部署必须配置服务 token，部署步骤见 [HANDOFF](docs/HANDOFF.md)。

## 新游戏接入

先冻结 GameBrief 和事件合同，向 `POST /v1/audio/plans` 请求方案；可信宿主核对五字段身份与预算，提交 `planId/planDigest/identity/acceptedItems/delivery` 到 jobs，并使用 Idempotency-Key。轮询取得不可变 manifest，校验、解码后接入本地播放器。运行时拾取、命中、循环都不请求生成 API。

| 入口 | 用途 |
|---|---|
| [交接与部署](docs/HANDOFF.md) | 算法、后端、前端接手与运维 |
| [接口交互](docs/API-INTERACTION.md) | 真实 v1 请求、确认、任务、包与预算 |
| [OpenAPI](docs/openapi.json) / [类型](docs/audio-service-types.d.ts) | 机器合同 |
| [管线合同](docs/PIPELINE-CONTRACT.md) | 身份、创作、媒体与运行边界 |
| [游戏接入](docs/GAME-PIPELINE-INTEGRATION.md) | 并行任务、opaque iframe、3D 与导出 |
| [请求样例](examples/audio-service-request.json) / [后端样例](examples/backend-orchestrator.mjs) | 可运行的计划与可信下载交付 |
| [算法模块](examples/algorithm-plugin.mjs) | 替换导演/作曲器的可信插件入口 |

默认输出 48 kHz Opus/Ogg，BGM stereo 64 kbps VBR、SFX mono 48；AAC-LC/M4A 回退分别 96/64。每 item 只交付一种编码，mix/stems 按需选择。默认 12 MiB 传输和 64 MiB 解码 Float32 PCM；WAV 母版保留服务缓存。[默认参数](examples/audio-delivery-defaults.json) 是说明配置，HTTP 以真实 schema 为准。

默认 local 不调用模型。可设置可信 GAME_AUDIO_DIRECTOR_MODULE，替换受校验的导演/谱面；也可配置 OpenAI-compatible 风格导演，但它只返回风格/速度/调式/主音，本地作曲和音源仍保留。本轮没有调用收费音乐模型或验证其质量。

队列采用单服务进程、本地文件锁与持久恢复，默认并发 1；不支持多实例共享目录。播放器提供可选 HRTF/距离衰减，旧 iframe adapter 只支持 pan；未实现遮挡、连续声源移动或完整 Three.js 自动集成。实际玩法、跨浏览器/移动端与主观听感需分别验收。

## 测试与证据

```sh
npm test
npm run service:e2e
npm run service:browser
```

npm test 检查分发、确定性作曲、合同、桥、旧研究 API、真实 v1 协议、队列与机器规范，其中队列失败/恢复采用受控渲染器；它不替代真实媒体渲染。service:e2e 启动独立服务与真实 Chromium/FFmpeg，生成 BGM/SFX、编码 Opus/AAC、逐文件验 hash、测缓存和进程重启。后者需要完整依赖，报告见 [service-e2e-validation](artifacts/service-e2e-validation.json)，源码哈希标明其适用版本。

service:browser 再启动专用 Chromium，验证原生解码、三分轨有效输出、断网本地触发/暂停恢复、独立 ZIP 运行、390 px 布局、失败时游戏继续和 HRTF 距离衰减。已有 [13 项实测记录](artifacts/service-browser-validation.json)，记录保留源码哈希与 sourcesUnchanged，最终以所测版本为准。HRTF 测量是原生离线上下文中 1 m / 10 m 的同声音效，不代表完整 Three.js 场景或空间听感通过。

旧完整音乐/引擎实验可用 render:probe、render:suite、engine:check，启动服务器后在另一终端运行。执行器启动自己的浏览器，不接管用户会话。引擎检查缺少未分发 raw SFX 基准时会明确标 passed-with-skips，不把跳过算通过。重做响度/素材分析需 FFmpeg 和对应 raw 输入，详见 [实验报告](REPORT.md)。

Dockerfile 包含 Node、FFmpeg 与匹配 Chromium 的安装和构建时启动检查，运行时需注入凭据并挂持久目录。本次 Windows 环境没有 Docker，未声称镜像已实际构建或发布。

## 先听历史作品

启动后打开 **http://127.0.0.1:4178/listen.html**，直接播放已有作品，无需重新渲染。

- [海岛场景混音](artifacts/cozy-game-context.mp3)、[海岛合成](artifacts/cozy-synth-listen.mp3) / [采样木琴](artifacts/cozy-hybrid-listen.mp3)。
- [霓虹动作](artifacts/neon-listen.mp3)、[幽暗遗迹](artifacts/ruins-listen.mp3)。
- [参考 SFX](artifacts/sfx-reference-listen.mp3) / [纯合成](artifacts/sfx-synth-listen.mp3) / [混合](artifacts/sfx-hybrid-listen.mp3)。

这些是 2026-11-16 的研究成品，历史 render-suite 和 runtime 报告不自动代表新服务源码的验收。盲听页 blind.html 使用匹配响度的 WAV，人工小样本为 1 位听者/8 事件，纯合成 4.5:3.5；不能推广为所有音效或 BGM 品质。混合版直接使用参考素材，不能作为纯合成追平的证据。

index.html 是原始作曲沙盘；pipeline.html 是旧浏览器离线渲染/opaque iframe 实验。它们保留历史研究用途，新服务接入使用 delivery.html。旧 `/api/audio/*` 和实验保存/盲测接口只允许 loopback，不是 v1 媒体包端点。

## 实现位置

| 位置 | 用途 |
|---|---|
| server/audio-api.mjs / audio-plan.mjs | 授权、v1 路由、不可变计划与媒体选择 |
| server/audio-jobs.mjs | owner 隔离、幂等、单进程队列、恢复与媒体包 |
| server/audio-director.mjs | local / 可信模块 / 兼容接口导演 |
| server/audio-renderer.mjs / audio-media.mjs | 原生 Web Audio 母版、缓存、FFmpeg 编解码验收 |
| src/director.mjs / composer.mjs / audio-engine.mjs | 有限风格、谱面、Tone 与 SFX 配方 |
| src/audio-service-client.mjs / audio-package-player.mjs | 验证/下载/解码与本地播放 |
| src/audio-package-export.mjs | 独立声音 ZIP |
| src/game-audio-pipeline.mjs / game-audio-bridge.mjs | 共享身份和受限沙箱事件通道 |
| assets/manifest.json / vendor/provenance.json | 固定音源、Tone 版本、许可与真实摘要 |

仓库含九份 MP3、两份盲测 WAV 与精选技术记录。全量 raw WAV、浏览器操作、盲测原始会话、.data 任务/母版/缓存、.env 和依赖安装不分发。

## 许可

Tone.js MIT，所用 Kenney / VSCO2 CE 源采样 CC0。自有代码尚未选择开源许可证；源码可读取不表示授予任意外部使用权。声音内容与代码许可分别记录，包附第三方许可与来源。见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)、[ASSETS](docs/ASSETS.md) 及 assets/licenses。
