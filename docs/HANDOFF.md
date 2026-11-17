# GameAudioLab 交接与部署

版本：v0.2.0 / audio-service-v1，2026-11-17。目标是供游戏生成器的算法、后端和前端团队接入独立声音服务。v1 的真实字段以 [OpenAPI](openapi.json)、[TypeScript](audio-service-types.d.ts)、[API 交互](API-INTERACTION.md) 与实现为准；[请求样例](../examples/audio-service-request.json) 可以直接调用。

## 当前交付范围

已实现不可变 plan、宿主确认、后台离线 Web Audio/Tone 母版、FFmpeg Opus/AAC、持久单进程任务队列与缓存、owner 授权隔离、幂等/取消/组件重试、部分包、重启恢复、摘要校验、浏览器本地 player 和声音 ZIP。游戏运行时不生成新音频，不携带 Tone 或模型依赖。

默认创作是有限 cozy/neon/ruins palette 与 seeded composer，不是端到端音乐模型。当前多 music slot 共享同主题；setScene 不自动切曲。完整新游戏生成、整款游戏导出装配、账户系统和正式生产部署不在本仓库实现。收费模型未调用，音乐/SFX 主观音质不能以技术测试替代。

## 算法团队

输入为共享 gameBrief、eventContract 和可选 seed。先固定事件语义、required 和频率，再创作谱面；不能让游戏和声音各自猜事件名。默认行为在 src/director.mjs / composer.mjs / audio-engine.mjs，声音原料在 assets/manifest.json；选用素材须可追溯与授权。

可配置 `GAME_AUDIO_DIRECTOR_MODULE` 为可信本地模块，导出：

```js
export const version = 'your-algorithm-v1';
export const modelConnected = false;
export async function directPrompt(prompt, { seed } = {}) { /* 返回受支持 audioBrief */ }
export async function composeScore(audioBrief, { gameBrief, eventContract }) {
  /* 可选：返回可校验 score JSON */
}
```

[algorithm-plugin.mjs](../examples/algorithm-plugin.mjs) 是可运行的本地实现模板。导演必须返回支持的 style/mode、bpm 60–180、rootMidi 36–84、bars:16、meter:4、无符号 seed 并保持调用方 seed。注入谱面需符合 validateComposedScore 的 timing、支持乐器/角色、1–16 tracks、最多 10,000 events 与音符边界；HTTP 最终时长还限 65 秒。算法若要更大 palette、更多小节或音源，需要显式扩展编译器与验证，不应靠返回任意代码绕过。

另一种配置是 openai-compatible：设置 provider、完整 Chat Completions URL、model、可选 key/timeout。实现要求 json_schema 响应，返回 style/mode/bpm/rootMidi；仍使用本地 seeded composer 和音色。它只验证风格导演接口，不表示已接通任意音乐供应商。模块配置优先于 provider，HTTP 请求不能选择模块路径或模型 URL。

versions.algorithm 记录模块主文件 SHA/version 或远程 model/endpointHash，不含 key。固定外部依赖和模型版本，并为改算法建立新的听审/玩法结果；模块主文件 hash 不递归覆盖全部依赖。

## 后端团队

把音频任务接在设计冻结之后，与游戏生成并行。保存五字段 identity（projectId/revision/briefHash/contractVersion/contractHash），按当前游戏版本核对每次回调。先创建 plan，再自动验证 required/格式/预算并确认 selected items；确认不是必须由玩家手工批准。

可运行样例：

```sh
node examples/backend-orchestrator.mjs examples/audio-service-request.json
```

样例默认连接 127.0.0.1:4178、只确认 required，使用 planDigest 派生稳定确认 key，下载真实媒体并验证完整 manifest/文件摘要。结果写到 `.data/host-export/<packageId>/`（媒体相对路径与 manifest），另存不含 token 的 host-job.json。配置项：

| 样例变量 | 作用 |
|---|---|
| GAME_AUDIO_SERVICE_URL | 服务 origin |
| GAME_AUDIO_API_TOKEN | 后端 bearer 凭据 |
| GAME_AUDIO_EXPORT_DIR | 输出目录，默认 .data/host-export |
| GAME_AUDIO_CONFIRMATION_KEY | 本次固定的幂等 key |
| GAME_AUDIO_RESUME_JOB | 已知 jobId，跳过规划/提交直接恢复查询 |

恢复时沿用原凭据 owner 和 jobId；SIGINT 只中断样例轮询，不会自动删除后台任务。样例遇 partial package 会保留实际资源，required 未齐返回非零，不能标整款游戏完全就绪。生产将这些状态存入自己的数据库，完成资产代理与游戏版本保存，而非依赖单个 host-job.json。

长期 token 放服务到服务的调用中；前端访问 BFF 时仍要校验用户对 project/job/package 的权限。单个 GAME_AUDIO_API_TOKEN 映射 owner=service；多团队用 GAME_AUDIO_API_TOKENS_JSON 的稳定 owner ID，密钥至少 24 字符且唯一。轮换 token 保持 owner 不变，不能仅改 projectId 期待授权隔离。

幂等范围为 owner/project/key；重放同内容，不能重用 key 改参数。轮询中断后先 GET 或原样重放；显式 DELETE 才取消后台工作。失败重试新 job，只重做 retryable 失败/取消组件，保留已完成项。升级源码使旧 confirmed plan stale 时重新规划；不要改旧 plan hash。

## 前端与游戏团队

使用 src/audio-service-client.mjs 下载/验证/解码，src/audio-package-player.mjs 本地播放。规划前 probeFormats 做实际解码探针，将有序 acceptedFormats 交后端；不要只按 UA 或 canPlayType 猜格式。HTTP API 的默认路径从 origin 根 `/v1/audio` 开始，若服务部署在路径前缀下，需代理/重写该根路径，不能只改 baseUrl 的尾部路径。

downloadPackage 核对 expectedIdentity、planId、planDigest、selectionDigest、manifest digest、文件长度/hash 与双预算。load 后在真实按钮手势 player.unlock，再 music.play(itemId) 或 play(eventId,payload)。包已在内存时，事件播放和音乐循环没有服务请求。默认同步 stems 是 core/texture/rhythm；强度显式 setIntensity，场景切曲显式 music.play。

状态至少分开游戏生成、音频生成、播放 locked/paused 和质量；监听 job.requiredReady/allSelectedReady 与逐组件错误。部分包的 digest 随新增组件改变，已下载字节可命中缓存。dispose 旧 player/client/桥、取消旧轮询，避免换 revision 后仍播旧声音。客户端内存缓存有界，但 bundle 和播放器仍持有缓冲；可选 IndexedDB 尚无自动总配额清理。

opaque iframe 只注入 GameAudio.emit/setScene/setIntensity，宿主持有资源与密钥。旧 createGameAudioAdapter 面向 Tone 渲染结果，新媒体包需窄 facade 接 player；[接线例](GAME-PIPELINE-INTEGRATION.md) 已列出。桥绑定 session、briefHash/revision、递增序号并只向当前 contentWindow 交端口，不把 origin=null 当身份认证。

新 player 可对 spatial.enabled 的 mono SFX 使用 HRTF 和距离衰减；宿主 setListener 与 position 使用统一世界坐标。旧桥只支持 pan，不自动转发 3D。未实现遮挡、混响区域、连续声源移动 handle 或 Three.js 场景同步；实际 3D 游戏和耳机/移动设备须另验。

exportAudioPackageZip 产出声音文件、清单、来源/许可与静态试听运行页；用静态 HTTP 打开，file:// 不保证。该 ZIP 没有生成服务 URL/token，但也没有自动合并生成的游戏。游戏打包器须装配相同 packageId 的资源和本地 runtime，并保留 MIME、二进制字节与许可。

## 默认格式与预算

48 kHz；默认 Opus/Ogg BGM stereo 64 kbps VBR（high:96），SFX mono 48（compact-approved:32）；AAC-LC/M4A 回退音乐 96、SFX 64。每 item 一种编码；音乐选择 mix 或三个 stems，不无条件附带全部版本。母版为 Float32 WAV，留服务缓存。

默认传输 12 MiB、解码 Float32 PCM 64 MiB，HTTP 上限 64/256 MiB。传输测量编码和 provenance 文件，不含 manifest HTTP 开销；PCM 测量实际解码帧×声道×4，浏览器还检查自身解码值。渲染图和临时内存另计。低码率不减少 PCM，长曲/分轨常驻需预算。compact-approved 的听审由调用方承担。

默认最多 32 items、64 events、4 music slots、65 秒单曲、1–3 SFX 变体；victory/failure 与 synth 的 ui/collect/laser/charge 只支持 1。required 估计提前限额，可选候选允许超总估计后选择子集，实际完整选择仍查预算。规范默认见 [audio-delivery-defaults.json](../examples/audio-delivery-defaults.json)。

## 本地与服务器启动

```sh
npm ci
npx playwright install chromium
npm run doctor
npm start
```

Linux 首装用 `npx playwright install --with-deps chromium`。FFmpeg 与 ffprobe 放 PATH（需要 libopus/AAC），或设置绝对路径。Playwright 版本已由 lock 固定，Chromium 必须由此版本安装；GAME_AUDIO_PLAYWRIGHT 可指定另外安装的 index.mjs，但生产优先仓库固定依赖。

[.env.example](../.env.example) 不含秘密。复制为 .env 后，Node 20.6+ 可 `node --env-file=.env scripts/server.mjs`；npm start 不自动读 .env。主要服务配置：

| 变量 | 默认 / 含义 |
|---|---|
| GAME_AUDIO_HOST / PORT | 127.0.0.1 / 4178；非 loopback 必须 token |
| GAME_AUDIO_DATA_DIR | .data/audio-service；持久化全部任务与媒体缓存 |
| GAME_AUDIO_CONCURRENCY | 1，HTTP 接受 1–4 |
| GAME_AUDIO_RENDER_TIMEOUT_MS | 180000，每次浏览器母版渲染期限 |
| GAME_AUDIO_API_TOKEN / TOKENS_JSON | 单 owner 或多 owner 凭据，所有 v1 入口均保护 |
| GAME_AUDIO_ALLOWED_ORIGINS | 逗号分隔精确来源，默认不给跨源授权 |
| GAME_AUDIO_FFMPEG / FFPROBE | ffmpeg / ffprobe 可执行文件 |
| GAME_AUDIO_DIRECTOR_PROVIDER | local 或 openai-compatible |
| GAME_AUDIO_DIRECTOR_MODULE | 可信模块路径，优先于 provider |
| GAME_AUDIO_DIRECTOR_URL / MODEL / KEY / TIMEOUT_MS | 可选风格导演完整 URL/model/key，超时默认 30000，范围 1000–120000 |

生产通过 HTTPS 反向代理/BFF 访问。TLS 在代理终止时将实际 HTTPS 前端 origin 加入允许列表；服务同源比较使用其 HTTP listener 的 host。包文件授权仍需要 bearer，不能把它当匿名 CDN；可由可信后端下载验证后放自己的资产域。旧 `/api/*` 研究写入/盲测接口在非 loopback listener 上拒绝，静态示例页和公开素材仍可访问。

## Docker

Dockerfile 基于 Node 22 Debian，安装 FFmpeg、由锁定 Playwright 下载 Chromium 和系统依赖，以 node 用户运行；构建阶段 doctor 和实际 Chromium 启动都成功才完成。运行需注入秘密，镜像没有默认 token：

```sh
docker build -t game-audio-lab:0.2.0 .
docker volume create game-audio-data
docker run --rm --init --name game-audio-lab \
  --env-file .env \
  -e GAME_AUDIO_HOST=0.0.0.0 -e GAME_AUDIO_DATA_DIR=/data \
  -p 127.0.0.1:4178:4178 \
  -v game-audio-data:/data --shm-size=1g \
  game-audio-lab:0.2.0
```

先在本地 .env 填入随机 GAME_AUDIO_API_TOKEN 或 TOKENS_JSON。上述为 POSIX shell 多行语法，PowerShell 可写一行。镜像默认非 loopback，无 token 会拒绝启动；bind mount 目录须允许 node 用户写入。只启动一个容器使用该 dataDir；健康检查读取运行时 token，仅报告 ready/失败。当前 Windows 研究机无 Docker，本轮未执行该构建，也未发布镜像；首次部署必须实际运行 build 与 service:e2e。

## 存储、恢复与运维

dataDir 包含 owner 命名空间中的 plans/jobs/packages/cache，另有原生 masters/encoded 缓存、temporary 和进程锁 `.audio-jobs.lock`。磁盘可随任务累积，当前没有自动 TTL/GC 或删除 package API；监控空间并制定保留策略。发布过的 manifest/package 不原地修改。

这是单进程文件队列，默认并发 1，待处理 64 / owner 16，不是 Redis/数据库分布式队列。不要给多个服务进程/NFS 主机共享目录来扩容；需要水平扩展时替换任务协调层。启动遇 store_in_use 先确认 owner 进程，不能盲删有效锁。

正常 SIGINT/SIGTERM 停止接收请求、取消活动渲染并保存可恢复状态。启动把未完 rendering 还原 queued，校验已就绪文件后复用。备份/迁移先停止服务再复制完整 dataDir，保留 owner 名称、plan、job 与 cache/package 一致性。跨主机恢复若有遗留锁，核实旧实例已停止并保留备份后再处理；服务不会把另一主机的锁自动判死。

升级引擎/素材/渲染源码后，旧 plan 可能 stale-renderer；新建 plan，旧不可变包仍可按原 owner 读取。不要为了复用旧任务手改存储 JSON 或清空摘要。健康检查不是实际渲染测试：GET health 可 200/degraded，应看 renderer.ready；doctor 检查工具链，真实 e2e 验证启动/渲染/编码/取包。

## 验证与发布门槛

`npm test` 运行协议/合同/资源/队列/规范检查，队列故障用受控 renderer；`npm run service:e2e` 运行真实独立 Chromium 和 FFmpeg，覆盖 BGM/SFX、Opus/AAC、摘要/Range、缓存、进程重启。

`npm run service:browser` 启动 fresh service 和专用 Chromium，真实验证 probe/decode、三分轨有效输出、短 SFX 部分包、手势解锁、断网零请求触发/暂停恢复、独立 ZIP 静态运行、390 px 布局、失败隔离与销毁。[已有报告](../artifacts/service-browser-validation.json) 为 13 项通过，记录模块源码 hash 与 sourcesUnchanged；代码改变后重跑，不能把旧通过贴到新版本。其 HRTF 测量为实际 player 加 native OfflineAudioContext 的同一 mono SFX，1 m/10 m 的 RMS 比约 0.10，只证距离衰减，不是完整 Three.js 或主观空间音质。390 px 检查是桌面 Chromium viewport，不等于真实手机/Safari 验证。

包的 technical passed、binding contract-validated-gameplay-not-evaluated、listening not-evaluated 分别记录。上线完整游戏前还要验证真实关键行为、版本切换、保存/重开/导出、预算与听感。历史 1 人/8 事件盲听和旧 44.1 kHz 测量不能当每个新游戏通过。历史资料见 [REPORT](../REPORT.md) 和冻结旧报告。

项目自有源码没有开源授权；Tone MIT，所用 Kenney/VSCO 源采样 CC0，包附 LICENSES/assets provenance。部署/交付需在项目所有者授权范围内，不能把依赖 MIT 当整个项目 MIT。不得把 .env、私人任务目录或原始听审记录放公开资产。
