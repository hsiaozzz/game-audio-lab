# 游戏声音项目：实现与验证报告

更新：2026-11-17。项目目标是独立于游戏生成器，让同一份提示词/设计同时驱动游戏和完整 BGM/SFX。当前已具备可运行的生成交付服务，听感提升仍需在有限 palette 与算法迭代中验证。

## 当前结论

本轮完成 plan → 确认选项 → 后台 Web Audio 母版 → FFmpeg Opus/AAC → 不可变包 → 浏览器本地播放/声音 ZIP。声音制作移到生成阶段，动作触发只播放本地缓冲；服务和游戏之间用版本化事件合同连接。持久任务、owner 隔离、幂等、组件重试、部分包和重启恢复已经实现，不再是待实现的协议草案。

默认关键词导演与 seeded phrase composer 仍只有 cozy/neon/ruins。可信模块可以替换导演与受约束谱面，OpenAI-compatible 配置只控制风格/速度/调式/主音。没有调用收费模型、没有证明任意提示词可生成精美成品音乐，也未改动或部署现有游戏生产项目。

新 package player 支持声明式单声道 SFX 的 HRTF/距离衰减；旧 bridge adapter 仍只接受 pan。未验证完整 Three.js 生成游戏、遮挡、连续移动声源或跨浏览器空间听感。外部游戏生成、完整游戏 ZIP 装配和发布仍由接入方负责。

## 本轮技术证据

[service-e2e-validation](artifacts/service-e2e-validation.json) 是真实服务进程、Chromium 与 FFmpeg 的端到端记录，包含各模块源码 SHA，覆盖实际 BGM/SFX 制作、按需选择、Opus/AAC、逐文件字节/hash/HEAD/Range、持久媒体缓存和服务重启。报告适用于其记录的源码版本，不能把历史通过自动套到后续修改。

该样本的 33.10 秒 neon stereo mix，Opus 约 330 KB，AAC 约 415 KB；单声道 collect 约 2.5 / 4.1 KB。精确字节以报告为准。两格式的母版帧相同（音乐 1,588,966 帧，SFX 20,878，48 kHz）。这是本机单样本的工程结果，不是速度基准、普适体积或主观品质保证。

[service-browser-validation](artifacts/service-browser-validation.json) 另有 13 项专用 Chromium 实测：真实探针/原生解码、三分轨非零输出、SFX 先到达、断网后零请求播放与暂停恢复、真实 ZIP 导出后独立静态运行、390 px 布局、服务失败后游戏继续及资源销毁。报告同时记录源码哈希和 sourcesUnchanged，适用版本以最终记录为准，复现入口为 `npm run service:browser`。

其中空间检查将同一已交付 mono SFX 交给实际 package player，在原生 OfflineAudioContext/HRTF PannerNode 中比较 1 m 与 10 m，RMS 比约 0.10，验证 inverse 距离衰减。该测试没有 Three.js 场景、遮挡或人工方向听审，不可扩大为完整 3D 游戏验收。

渲染模块另外实测过 12 类 cue、不同变体、48 kHz 原生母版、Opus/AAC 解码、取消、旧源码拒绝与三层帧同步；完整 cozy 的一次 41.739 秒 Opus mix 为 413,705 bytes、制作约 31.287 秒。这些研究明细保存在本地 .data，未作为新版本整机性能承诺。三层短样本只验证同步机制，不能冒充完整分轨作品听审。

`npm test` 检查协议、确定性、资源、桥和队列；队列的失败/恢复注入受控渲染器，与 service:e2e 真实媒体测试分开。技术质量 passed 表示非静音、有限数值、无削波和可解码等检查；包的 listening 仍为 not-evaluated，binding 仅合同验证，实际玩法未评估。

Dockerfile 提供 FFmpeg、匹配 Chromium 与构建时启动检查的配方；本次 Windows 环境未安装 Docker，未执行镜像构建或远程部署。运营配置、前后端和算法接手见 [HANDOFF](docs/HANDOFF.md)。

## 历史音乐与听感研究

完整旧报告冻结在 [HISTORICAL-REPORT-2026-11-16](docs/HISTORICAL-REPORT-2026-11-16.md)。其中“当前/尚未实现/下一步”指当日状态，不是本轮服务状态。原始指标与试听保留，不将它们改写为新代码的验收。

| 2026-11-16 正式样本 | 配器 | 时长 | 本机离线渲染 | mix + 三分轨 PCM |
|---|---|---:|---:|---:|
| cozy-synth | 合成木琴、柔和键盘、低音、打击 | 41.74 秒 | 31.70 秒 | 58.90 MB |
| cozy-hybrid | VSCO2 木琴采样，其余合成 | 41.74 秒 | 28.81 秒 | 58.90 MB |
| neon-synth | lead/pad/bass/鼓 | 33.10 秒 | 19.53 秒 | 46.72 MB |
| ruins-synth | 钟/pad/pluck/低音 | 46.83 秒 | 24.45 秒 | 66.09 MB |

来源为 [render-suite](artifacts/render-suite.json)，44.1 kHz stereo Float32，仅计保留四个 buffer，临时图/素材/JS 另计。新服务实际交付为 48 kHz，不能直接照搬旧内存数字。Tone bundle 345,500 bytes，17 个精选音源共 969,748 bytes；它们不包含生成音乐 PCM。

海岛合成/采样两版使用相同 seed 1701 和谱面，只施加常量增益对齐到约 −22 LUFS。八事件 SFX 对照按事件匹配响度，最终同事件三路最大差 0.10 LU。混合版含参考 Kenney 采样，不能证明纯合成达到参考水平。频带差异也不能直接替代质量评分。

历史人工盲听仅 **1 位听者、8 类事件**：纯合成 4.5、Kenney 3.5，3 胜/2 负/3 平。它只反映当前样本与这位听者的偏好，不涵盖 BGM 或真实连续玩法。自动化 QA 会话不计人工偏好，原始私人会话不随仓库分发。[盲听规则](docs/BLIND-TEST.md)、[Kenney 对照](docs/KENNEY-BENCHMARK.md) 保留测量边界。

旧 [pipeline-browser-validation](artifacts/pipeline-browser-validation.json) 有 15 项真实浏览器检查、一次 neon 音频约 23.07 秒就绪；这是旧宿主浏览器渲染路线。新版改为后台交付，该历史耗时不作为新版性能结果。runtime-validation、audio-engine-validation 等也按各自记录的源码哈希解释。

## 下一阶段的实际缺口

1. 在一条真实的新游戏生成任务上联调身份、事件、存储、重开和整款游戏导出，再做 Three.js 场景内距离/方向验证。
2. 精修少量风格的旋律、编排、音色、材质与重复疲劳，增加听者与场景内听审；音乐质量不能由峰值、LUFS 或频谱替代。
3. 把算法模块接入受约束的创作模型，固定模型/音源/依赖版本，核对成本、等待和授权；现有兼容风格接口不等于端到端音乐模型。
4. 为正式多用户运营补账户/项目授权、磁盘保留策略、监控和所需队列基础设施。当前本地文件队列应由单服务进程独占，不能直接多副本共挂。

## 资料与许可

[Tone.js](https://tonejs.github.io/)、[howler.js](https://github.com/goldfire/howler.js#documentation)、[OfflineAudioContext](https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext)、[Web Audio 时钟](https://web.dev/articles/audio-scheduling?hl=en) 是基础参考。Tone 用于编排/离线合成，Web Audio 用于原生缓冲和混音；howler 是成熟播放库，但当前 package player 直接使用 Web Audio，未叠加它。

Tone MIT、Kenney/本次 VSCO2 CE 源采样 CC0 分别留档，自有代码无开源授权。见 [来源与许可](THIRD_PARTY_NOTICES.md)、[素材处理](docs/ASSETS.md)。
