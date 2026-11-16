# 独立游戏声音生成实验

日期：2026-11-16。目标：同一份游戏提示词同时驱动游戏与精美 BGM / SFX，形成独立项目。

## 结论与产品路线

这条路线能够落地为「结构化创作 → 精选音色 → 音乐/音效编译 → 统一 Web Audio
运行时」系统。本次已做出真实音频、动态分轨和可直接试听的原型，技术链路可行。
通用提示词创作和成品音乐品质尚未得到验证。

本轮还把接入边界做成独立可运行样本：共享 brief/事件合同经声音 plan API 规划，
沙箱小游戏先可玩，音频由父宿主渲染并解锁，通过 MessageChannel 接收真实玩法事件。
这验证了声音模块与游戏运行的配合；小游戏为预先编写的样本，没有调用游戏生成模型。
具体接入位置与后续 API/导出设计见 [游戏管线集成](docs/GAME-PIPELINE-INTEGRATION.md)。

对 Kenney 级别的音效目标，建议把有来源的精选素材与精修合成配方共同作为基础。
提示词驱动的是世界观、材质、动作语义、层次和变体，再由平台稳定执行。材质类声音
优先使用合适的采样原料；UI、奖励、能量等可精修程序合成。无需为每款游戏重新编写
一套自由发挥的振荡器代码。

完整配乐的质量取决于主题、和声、段落发展、音色及游戏内混音。Tone 提供编排和音源
工具，Web Audio 提供输出和混音；howler 适合播放已有音频，当前首版不必叠加。
后续可让 AI 输出受约束谱面和声音设计数据；复杂写实音效或音乐生成模型可作为额外
音源，但仍需验证节拍、循环、分轨、等待成本和事件绑定。

## 本轮实际完成范围

本项目与现有游戏项目独立。旧项目与用户自备的 `audioX` 原始素材只被读取。
新项目没有部署、没有调用收费生成 API。

当前导演是关键词路由，作曲器是 seeded phrase composer，覆盖三种配置；不是任意
提示词 AI 音乐模型。演示场景为固定 Canvas 沙盘；没有同步生成完整新游戏。
真实 Three.js 游戏中的位置衰减、遮挡和 HRTF 也未在这轮验证。

新增 `/pipeline.html` 宿主保留了现有生成器的 opaque iframe 限制，游戏内部零音频
资源请求，只有事件桥；`POST /api/audio/plan` 提供独立规划入口。正式游戏生成器
仅只读检查，实际接入和部署尚未执行；完整后台音频渲染、持久化任务及独立导出不在
本次实现范围。

## 管线宿主实际验证

[pipeline-browser-validation](artifacts/pipeline-browser-validation.json) 的 **15 项真实
浏览器检查全部通过**：游戏在声音制作期间可玩，opaque iframe 禁止网络；三个真实
分轨成功渲染并播放，实际 PCM 输出有效；真实手势解锁、游戏事件、旧版本拒绝、
暂停恢复、音频失败后的游戏可玩性、错版计划拒绝及 390 px 手机布局均通过。

本机一次 neon 合成配器实测：固定小游戏 **0.02 秒**可玩，声音任务 **23.07 秒**就绪；
其中 `renderStats.renderMs` 为约 **23.05 秒**。输出包含 core / texture / rhythm
三层，33.10 秒音乐，非有限值和削波样本均为 0。这是单次、本机测量，不能推广为
任意游戏、设备或模型的性能保证，也不是主观听感结论。

[pipeline-validation](artifacts/pipeline-validation.json) 最新通过 **39 项**合同与
adapter 检查，其 runtime 为模拟对象，不生成 PCM；真实声音证据来自上一份浏览器
报告。当前宿主桥已可运行，生产游戏生成项目仍未接入；规则导演并非任意提示词 AI，
可脱离宿主的独立媒体包与后台渲染服务仍未完成。

链路：提示词 → GameBrief → MusicScore → Tone.Offline → 三个音乐分轨 + mix →
统一 AudioContext → 声音事件/动态强度。每首 16 小节、4/4、六声部，曲式为 A8+B4+A′4。
为保留循环尾音，每个分轨离线渲染两个周期，再截取第二周期。

## 实际 BGM 与成本

| 正式样本 | 配器 | 时长 | 本机离线渲染 | mix + 三分轨 PCM |
|---|---|---:|---:|---:|
| cozy-synth | 合成木琴、柔和键盘、低音与打击乐 | 41.74 秒 | 31.70 秒 | 58.90 MB |
| cozy-hybrid | VSCO2 木琴采样，其余合成 | 41.74 秒 | 28.81 秒 | 58.90 MB |
| neon-synth | 合成 lead / pad / bass / 鼓 | 33.10 秒 | 19.53 秒 | 46.72 MB |
| ruins-synth | 合成钟音 / pad / pluck / 低音 | 46.83 秒 | 24.45 秒 | 66.09 MB |

数据来自 [render-suite](artifacts/render-suite.json)，44.1 kHz 立体声 Float32。
这是单台电脑的单次实验成本，不是跨设备基准，也没有与其他音乐生成系统做速度对照。
上述内存只计保留的四个 PCM buffer；离线渲染临时图、解码素材和 JS 开销另计。

结论是把完整渲染放在生成阶段，并按谱面、音色和编译器版本缓存。游玩时播放少量
同步分轨。正式产品需避免同时常驻许多长曲，且当前原型的持久化缓存尚未实现。

Tone bundle 为 345,500 bytes；精选音源为 969,748 bytes，共 17 个文件。压缩 MP3
减小传输体积，不能减小解码后的上述 PCM 内存。970 KB 也不是全部项目或整首音乐体积。

海岛 A/B 的完整乐谱 SHA256 相同，seed 均为 1701。两份 MP3 只施加常量增益做试听
电平对齐，复测均为 −22.00 LUFS。没有用更响的版本冒充更好的音色。

## Kenney 音效对照

用户提供的 `audioX` 有 5 包、408 个 OGG，约 9.26 MB。详细映射、包络、频带及
类别差距见 [Kenney 分析](docs/KENNEY-BENCHMARK.md)。这些是 SFX 参考，不能据此
证明 BGM 的作曲达到某个标准。

已实际生成三路八事件对照：

| 路线 | 声音来源 | 试听 |
|---|---|---|
| 参考 | 预处理 Kenney 样本单奏 | [reference](artifacts/sfx-reference-listen.mp3) |
| 程序合成 | 无采样的振荡器、噪声与包络 | [synth](artifacts/sfx-synth-listen.mp3) |
| 混合 | 相同参考素材与程序层，脚步当前主要为采样 | [hybrid](artifacts/sfx-hybrid-listen.mp3) |

均按 UI → 收集 → 挥动 → 草地脚步 → 木质命中 → 激光 → 蓄力/场效 → 爆炸，
每 1.8 秒一个事件，总长 14.4 秒。参考轨保留明确的处理来源，未称为完全原始 OGG。

每个事件分别用 FFmpeg EBU R128 分析，三路施加常量增益到共同目标；峰值空间不足时
共同降低目标。短音效的门限会随增益改变，因此根据输出再校正。最终 WAV 同事件三路
最大响度差为 **0.10 LU**；未使用压缩或限制器。MP3 是方便播放的副本，准确比较可用
仓库中的 `sfx-synth-matched.wav` / `sfx-reference-matched.wav`。每事件增益、测量结果
保留在 [sfx-comparison](artifacts/sfx-comparison.json)。三路 raw WAV 与混合版 matched WAV
只在研究机器保留，默认仓库不包含；三路 MP3 均随仓库提供。

当前程序配方的工程差距包括：挥动缺少中段建立的空气包络；脚步缺少地面与接触阶段；
命中缺少材质共振及阻尼；蓄力与参考场效的声音身份不同。不能把频谱不同直接评为更差，
也不能通过扩大频带或增加混响机械追平。

混合版直接含 Kenney 采样。其质量提升只能支持采样/合成组合的价值，不能作为纯合成
达到 Kenney 的证据。

已另备 [隐藏来源盲测页](http://127.0.0.1:4178/blind.html)：八组同事件的纯合成与
Kenney 参考随机 A/B，完整听完双方后投票，结束再揭晓分数。它使用匹配后的 WAV
片段；混合版不参赛。详见 [规则](docs/BLIND-TEST.md)。

已完成一次匿名人工盲听，**1 位听者、8 类事件：纯合成 4.5 分，Kenney 3.5 分；
纯合成 3 胜、2 负、3 平**。该结果只表示这位听者对当前八组样本的偏好，不是统计性
质量证明，也不涵盖 BGM、所有声音类别或真实游戏中的连续触发。原始会话和逐题投票
保留在本地；仓库仅记录上述匿名汇总。后续仍需增加听者及场景内验证。

盲测 API 合同检查通过，页面也实测了完整播放门槛、中途切换不算听完、
下一题重置、八题后揭晓和手机布局。自动测试全部用独立 `qa` 会话，得分没有真人
偏好含义。API 检查由 `npm test` 复现，生成本地 `artifacts/blind-api-validation.json`；
[页面检查](artifacts/blind-ui-validation.json) 为已有浏览器实测记录。服务检查另外覆盖
资源白名单、HEAD/Range 与会话跨进程恢复。会话音源哈希改变时需新建测试，避免混用来源。

## 技术测试结果

四份 BGM、音效展示和 22 秒场景混音均真实渲染为 WAV：无非有限值、无饱和削波样本，
输出非静音。PCM 波形与 FFmpeg EBU / 真峰值报告见
[audio-analysis](artifacts/audio-analysis.json)。MP3 全部成功解码，见
[listen-analysis](artifacts/listen-analysis.json)。

完整原始 BGM WAV、早期试听与浏览器操作记录仅在研究机器留档，不随仓库分发。
报告内的渲染耗时与波形指标是原实验记录；仓库默认提供压缩试听、必要盲测源与测量 JSON。

| 正式 WAV | 综合响度 LUFS | 真峰值 dBTP |
|---|---:|---:|
| cozy-synth | −22.55 | −3.89 |
| cozy-hybrid | −22.05 | −4.67 |
| neon-synth | −18.46 | −1.00 |
| ruins-synth | −22.77 | −5.77 |
| sfx-showcase | −30.54 | −9.33 |
| cozy-game-context | −26.36 | −9.36 |

这些是不同用途样本，未统一成单一母带响度。音效串听中的静音和短瞬态会影响指标。
Neon 的 MP3 真峰值为 −0.87 dBTP，说明有损编码会产生峰值变化；不是严格 −1 dBTP
交付。当前 DynamicsCompressorNode 是混音保护，不是严格真峰值母带限制器。

循环首尾差也已记录；例如 neon 约 0.01886，小于其一般相邻采样差的 P99，但这不能
证明人耳听不到循环接缝。循环几次后的疲劳感、段落自然度和尾音仍属于听审范围。

最终 runtime 在真实点击解锁后通过 **12 项检查**：实际 PCM 输出、三个真实分轨、
24 次音效中接受 12 / 拒绝 12、真实静音、下一小节强度变化、暂停后无输出、暂停位置
稳定、恢复、停止与销毁等。见 [runtime-validation](artifacts/runtime-validation.json)。

补充边界检查验证了：离线渲染故意失败后能恢复 context 并再次渲染；非循环曲目自然
结束后状态清理；charge 保留采样尾音；小调胜利 cue 使用正确三度。停止音乐增加
12 ms 淡出。以上不等同人工确认“完全无点击声”。
边界检查的既有结果与记录限制保存在 [engine-edge-validation](artifacts/engine-edge-validation.json)。

发布前补充的 [audio-engine-validation](artifacts/audio-engine-validation.json) 通过 20 项
引擎检查，覆盖暂停、停止、销毁、离线渲染失败恢复、静音分轨与输入校验，并记录当前
引擎及 SFX 配方哈希。这轮没有重渲染四首完整 BGM，原渲染耗时与音质指标仍为历史测量。

SFX 使用音频当前时间 +4 ms 排程，避免沿用音乐较长 lookahead。这是调度设置，
不是输入到扬声器总延迟实测。移动端、长时间运行、后台恢复与真实 3D 游戏仍需验证。

## 面向完整独立产品的下一步

1. **先精修少量声音风格。** 用同一游戏场景检验原声/合成/混合，按材质与事件语义
   组织声音变体。Kenney 是首批音效参照，完整音乐另外选有使用权的风格参照。
2. **接入真正 AI 导演。** 输入共享 GameBrief、玩法与事件合同，输出 AudioSpec、
   MusicScore、SfxSpec；校验音域、节奏、配器、资源预算，保留可编辑谱面。
3. **做独立 AudioPackage。** 包含混音、同步分轨、谱面、事件映射、来源、版本和质量
   状态；内容哈希缓存。当前只是合同草案，详见 [PIPELINE-CONTRACT](docs/PIPELINE-CONTRACT.md)。
4. **与一条真实新游戏生成任务并行联调。** 复用本轮已实现的 plan API、合同 adapter
   与 opaque iframe 桥，把预先编写的小游戏替换为模型新生成的产物。沿用同一 brief
   revision，校验暂停、胜负、场景变化与独立导出；再扩展 Three.js 三维空间音频。
5. **保留独立听审门槛。** 匹配响度盲听，对旋律、廉价感、材质、重复疲劳和操作反馈
   评分。技术通过与听感通过分别记录，不能用频谱或 LUFS 替代后者。

## 官方资料与来源

- [Tone.js](https://tonejs.github.io/) 与 [Performance](https://github.com/Tonejs/Tone.js/wiki/Performance)
- [howler.js 文档](https://github.com/goldfire/howler.js#documentation)
- [OfflineAudioContext](https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext)
- [Web Audio 两种时钟与调度](https://web.dev/articles/audio-scheduling?hl=en)
- [Kenney Interface](https://kenney.nl/assets/interface-sounds)、[Impact](https://kenney.nl/assets/impact-sounds)、[RPG](https://kenney.nl/assets/rpg-audio)、[Sci-Fi](https://kenney.nl/assets/sci-fi-sounds)
- [VSCO2 CE 固定来源](https://github.com/sgossner/VSCO-2-CE/tree/440300901dfe9275fd84e0b7763af1f8443ae62e)

Tone MIT 与采样 CC0 分别留档，音高校准、来源和核验边界见 [ASSETS](docs/ASSETS.md)。
