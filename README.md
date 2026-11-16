# GameAudioLab

独立的「游戏提示词 → BGM / 音效 / 游戏事件」研究项目。2026-11-16。

目标是让同一份游戏需求驱动玩法和完整声音设计，游戏生成与音频生成并行进行，最后按
事件合同组合。本目录与现有游戏项目分开；目前交付的是可试听、可复现的声音研究原型。

## 与新游戏生成配合

启动后打开 **http://127.0.0.1:4178/pipeline.html**。这个演示先让沙箱小游戏可玩，
同时由宿主调用 `POST /api/audio/plan` 规划声音，再实际渲染，完成后点击开启声音。
小游戏只发送语义事件，父宿主统一播放音乐和音效；它运行在无同源权限的 iframe，
不请求音频资源。这对应现有游戏生成器的离线预览限制。

[真实浏览器检查](artifacts/pipeline-browser-validation.json) 的 15 项全部通过，包括三层
实际播放、有效 PCM 输出、游戏事件触发、暂停恢复与音频失败后继续游玩。本机一次
neon 实测中，固定小游戏 0.02 秒可玩，三层声音约 23.07 秒就绪；这不是通用性能保证。
[管线合同检查](artifacts/pipeline-validation.json) 另通过 39 项，使用模拟 runtime，
与上述真实浏览器音频验证分别记录。

当前游戏为预先编写的接入样本，音频仍使用三类规则导演；尚未调用游戏生成模型。
接入方案、共享 brief、任务版本汇合、部分就绪、失败恢复与导出限制见
[游戏生成管线接入](docs/GAME-PIPELINE-INTEGRATION.md)。旧游戏项目没有改动，独立
后台渲染队列与可脱离宿主的完整音频包导出仍待实现。

具体请求、响应与宿主调用顺序见 [接口交互协议](docs/API-INTERACTION.md)。后续合作
采用两阶段：先返回声音方案，宿主自动核对共享合同与版本、选定所需交付项，再提交
渲染任务；游戏运行时播放已交付的本地音频，不在每次动作时调用生成服务。
这套按需交付协议仍是未来设计，当前已实现的是本地 plan API、adapter 与 iframe 桥。

## 先听成品

要隐藏来源评选，打开 **http://127.0.0.1:4178/blind.html**：八组同类事件、随机顺序、
随机 A/B；两版完整听完再投票，全部完成才揭晓来源及分数。当前赛程为纯合成对 Kenney，
混合版不参赛。使用逐事件匹配响度的 WAV，无 MP3 编码差异，详见 [盲测说明](docs/BLIND-TEST.md)。

本机服务运行时打开 **http://127.0.0.1:4178/listen.html**，不需要重新渲染。

- [海岛场景混音，22 秒](artifacts/cozy-game-context.mp3)：BGM 与抛投、入水、收集等事件。
- [Kenney 参考](artifacts/sfx-reference-listen.mp3) / [纯程序合成](artifacts/sfx-synth-listen.mp3) / [混合设计](artifacts/sfx-hybrid-listen.mp3)：逐事件匹配响度。
- [海岛纯合成 BGM](artifacts/cozy-synth-listen.mp3) / [海岛采样木琴 BGM](artifacts/cozy-hybrid-listen.mp3)：相同乐谱，seed 1701，均约 −22 LUFS。
- [霓虹动作 BGM](artifacts/neon-listen.mp3) / [遗迹探索 BGM](artifacts/ruins-listen.mp3)。

[实验结论](REPORT.md) · [接口交互](docs/API-INTERACTION.md) · [Kenney 对照分析](docs/KENNEY-BENCHMARK.md) · [未来管线合同](docs/PIPELINE-CONTRACT.md)

技术检查通过不等于音乐已经达到成品听感。三路音效的混合版直接使用参考素材；它不能
证明纯合成已经达到 Kenney 的水平。场景混音是脚本化试听，没有声称来自完整游戏录像。

已完成一次匿名人工盲听：**1 位听者、8 类事件，纯合成 4.5 分，Kenney 3.5 分；
纯合成 3 胜、2 负、3 平。** 这是当前八组样本的小样本偏好，不能推广到所有音效，
也不能据此证明 BGM 品质。自动化 QA 会话没有计入这个结果。

## 当前能力

- 三类本地风格导演：海岛休闲、霓虹动作、幽暗遗迹。关键词决定配置，seed 决定乐句。
- 16 小节 A / B / A′ 乐谱、六个声部，编译为 core / texture / rhythm 三个同步分轨。
- Tone.js 15.1.22 合成器与海岛木琴采样；真实 Web Audio 离线渲染、WAV 导出。
- 一个实时音频时钟、事件音效、分轨强度、音乐 ducking、静音、暂停恢复与声部上限。
- 固定等距场景沙盘，支持触发音效；这是声音演示场景。
- 独立声音 plan API、可校验的游戏事件 adapter 与 opaque iframe MessageChannel 桥。
- 新游戏管线宿主演示：游戏先可玩、声音随后就绪，再用真实游戏事件驱动声音。
- 11 个 Kenney SFX 与 6 个 VSCO2 木琴采样的精简音源包，约 970 KB。

当前没有通用 AI 音频导演、完整游戏生成器、正式 AudioPackage 打包/后台渲染服务、
持久化渲染缓存或真正的 3D 距离/HRTF 空间音频。neon / ruins 的 BGM 当前均为合成配器；选择
hybrid 也不会自动变成管弦乐或采样配器。

## 启动与复现

安装 Node.js 20+，将仓库克隆或解压到任意目录，在项目根目录运行。默认使用已固定的
Tone bundle、音源与试听成品，无需安装依赖或联网下载：

```sh
npm start
```

打开 http://127.0.0.1:4178/。点击示例、选择音源，编排渲染后点击播放以解锁浏览器音频。
本机四次完整渲染约需 20–32 秒/首；不是即时生成。试听页可以直接播放已有文件。

服务仅监听 127.0.0.1。通过 `GAME_AUDIO_PORT` 修改端口。它是本地研究服务器，提供
网页资源、音源包和实验产物保存接口；尚未实现可部署的多用户服务。Windows PowerShell
可先设置 `$env:GAME_AUDIO_PORT='4180'`；macOS/Linux 可用 `GAME_AUDIO_PORT=4180 npm start`。
盲测会话落盘后可跨服务重启恢复；会话原始记录只保存在本地，不随仓库分发。

`npm test` 检查四个页面及本地模块资源、音源/依赖哈希、九份试听文件、可重现作曲、
共享设计/事件合同、iframe 消息桥、盲测 API 与本地服务合同，
不需要 Playwright、FFmpeg、旧游戏项目或网络；测试使用独立 QA 会话，不代表人工听审。

需要重新执行浏览器离线渲染时，另行安装可选的开发依赖与专用 Chromium：

```sh
npm ci
npx playwright install chromium
```

保持 `npm start` 在一个终端运行，在另一个终端执行 `npm run render:probe` 或
`npm run render:suite`。`npm run engine:check` 可单独检查音频引擎边界与生命周期。
执行器从本项目安装的 Playwright 启动独立浏览器。渲染脚本支持 `GAME_AUDIO_PORT` 或
完整 `GAME_AUDIO_ORIGIN`；引擎检查使用 `GAME_AUDIO_ORIGIN`。也可用
`GAME_AUDIO_PLAYWRIGHT` 指定已安装模块的入口文件。
这些执行器不连接用户的浏览器会话，也不属于默认 `npm test`。
仓库不含三路 raw SFX 基准 WAV，`engine:check` 在缺少它们时会明确跳过基准比较，
继续执行生命周期与输入检查，并标记 `passed-with-skips`；不会把跳过算成比较通过。

```sh
npm run compose:check
npm run analyze
node scripts/analyze-listens.mjs
node scripts/compare-sfx.mjs
node scripts/check-blind-api.mjs
```

音频分析和比较需要 FFmpeg 在 PATH；`analyze-listens.mjs` / `compare-sfx.mjs` 还支持
`GAME_AUDIO_FFMPEG`。比较脚本读取
已导出的三路 raw WAV，逐事件测量响度并施加常量增益，保存 WAV 与 MP3 和增益记录。
全量原始 WAV、早期实验与自动测试会话保留在研究机器，默认仓库没有包含这些大文件；
需要重新生成相应输入后才能重跑依赖它们的分析。`npm test` 不使用这些原始文件。

`npm run setup:tone` 可重取固定版本并核对固定 integrity 与 bundle SHA-256，需要系统
提供 `tar`。`npm run assets:prepare -- --source <Kenney目录>` 可从自备的本地 Kenney
目录和固定 VSCO commit 重建音源；也支持 `GAME_AUDIO_SOURCE`、`GAME_AUDIO_FFMPEG`
与 `GAME_AUDIO_FFPROBE`，具体见 [素材说明](docs/ASSETS.md)。
现有文件已齐全，正常使用无需下载。

## 目录

| 位置 | 用途 |
|---|---|
| `src/director.mjs` | 有限关键词风格导演与事件映射 |
| `src/composer.mjs` | 可重现的乐句、和声与编排 |
| `src/audio-engine.mjs` | Tone 离线渲染、Web Audio runtime、音效设计 |
| `listen.html` | 直接试听已生成的文件 |
| `blind.html` | 随机隐藏来源的八组偏好盲测 |
| `pipeline.html` | 新游戏生成与声音并行的独立宿主演示 |
| `src/game-audio-pipeline.mjs` | 共享设计、事件合同、声音计划与游戏 adapter |
| `src/game-audio-bridge.mjs` | opaque iframe 与宿主之间的受限事件通道 |
| `scripts/blind-api.mjs` | 服务端保存随机映射与投票，结束后揭晓 |
| `assets/manifest.json` | 素材来源、许可、音高映射与哈希 |
| `artifacts/render-suite.json` | 四份 BGM 实际渲染记录 |
| `artifacts/runtime-validation.json` | 最终 runtime 的真实输出测试 |
| `artifacts/audio-engine-validation.json` | 发布前音频引擎边界与生命周期检查 |
| `artifacts/sfx-comparison.json` | Kenney 对照、逐事件响度与处理记录 |
| `artifacts/audio-analysis.json` | WAV 波形与 FFmpeg 响度检测 |
| `artifacts/listen-analysis.json` | MP3 解码与响度检测 |

仓库包含默认网页需要的九份 MP3、盲测两份匹配 WAV 与精选测量报告。早期 `*-ego`、
`*-headless`、`*-promptseed` 和全量 BGM WAV 仅在本地保留，不随仓库分发。
正式海岛 A/B 使用相同 seed 的 `cozy-synth` / `cozy-hybrid`；报告中的历史测量不代表
每次克隆都会重新渲染。用户盲测原始会话、浏览器操作脚本、下载缓存同样不分发。

## 许可

Tone.js：MIT；Kenney 与本次使用的 VSCO2 CE 源采样：CC0。代码库许可与声音内容许可
分别记录。项目自有代码尚未选择开源许可证。第三方来源和许可见
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)；固定版本、处理方法和本地来源核验边界
见 [ASSETS](docs/ASSETS.md)、`vendor/provenance.json` 和 `assets/licenses/`。
