/**
 * Wire and browser SDK types for the implemented /v1/audio API.
 * These are type-only declarations, not a runtime SDK entry point.
 *
 * import type { AudioServiceClient } from './docs/audio-service-types';
 * import { createAudioServiceClient } from './src/audio-service-client.mjs';
 * const audio = createAudioServiceClient({ baseUrl }) as AudioServiceClient;
 *
 * Unknown request fields are rejected in plan/job envelopes, audio requests,
 * options and delivery. Shared brief/event metadata is intentionally extensible.
 * A generation/playback event never triggers synthesis or a network request.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
/** 64 lowercase hexadecimal characters; validate at trust boundaries. */
export type Sha256 = string;
export type PlanId = `plan-${string}`;
export type JobId = string;
export type ItemId = string;
export type FileId = string;
export type FormatId = 'opus-ogg' | 'aac-lc-m4a';
export type CueId = 'ui' | 'collect' | 'cast' | 'splash' | 'footstep' | 'footstepWood' | 'hit' | 'laser' | 'charge' | 'explosion' | 'victory' | 'failure';

export interface GameIdentity {
  projectId: string;
  revision: number;
  briefHash: Sha256;
  contractVersion: number;
  contractHash: Sha256;
}

export interface GameBriefFields {
  schemaVersion: 1;
  projectId: string;
  prompt: string;
  eventContractVersion?: number;
  [metadata: string]: JsonValue | undefined;
}
/** revision and legacy briefRevision must agree when both are present. */
export type GameBrief = GameBriefFields & (
  | { revision: number; briefRevision?: number }
  | { revision?: number; briefRevision: number }
);

export interface GameEvent {
  id: string;
  cue?: CueId | null;
  required?: boolean;
  maxRatePerSecond?: number | null;
  [metadata: string]: JsonValue | undefined;
}
export interface EventContract {
  schemaVersion?: 1;
  version: number;
  events: GameEvent[];
  sceneStates?: string[];
  [metadata: string]: JsonValue | GameEvent[] | undefined;
}

export interface SpatialRequest {
  enabled: boolean;
  /** Defaults: 1, 100, 1, inverse. maxDistance >= refDistance. */
  refDistance?: number | null;
  maxDistance?: number | null;
  rolloffFactor?: number | null;
  distanceModel?: 'inverse' | 'linear' | 'exponential' | null;
}
export type Spatial = { enabled: false } | {
  enabled: boolean;
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
  distanceModel: 'inverse' | 'linear' | 'exponential';
};

export interface Delivery {
  profile: 'compact-opus-v1';
  /** Ordered preference. Every item chooses one format, never both. */
  acceptedFormats: FormatId[];
  selection: 'one-format-per-item';
  formatOverrides: Record<ItemId, FormatId>;
  quality: 'compact' | 'high';
  sfxQuality: 'standard' | 'compact-approved';
  renderMode: 'hybrid' | 'synth';
  maxTransferBytes: number;
  maxDecodedPcmBytes: number;
}
export interface DeliveryRequest {
  profile?: Delivery['profile'];
  acceptedFormats?: FormatId[] | null;
  selection?: Delivery['selection'];
  formatOverrides?: Record<ItemId, FormatId> | null;
  quality?: Delivery['quality'] | null;
  sfxQuality?: Delivery['sfxQuality'] | null;
  renderMode?: Delivery['renderMode'] | null;
  maxTransferBytes?: number | null;
  maxDecodedPcmBytes?: number | null;
}
export interface SfxRequest {
  id: ItemId;
  kind: 'sfx';
  eventId: string;
  required?: boolean;
  /** 1..3, cue dependent. victory/failure and some synth cues allow only 1. */
  variants?: number | null;
  spatial?: SpatialRequest;
}
export interface MusicRequest {
  id: ItemId;
  kind: 'music';
  scene: string;
  required?: boolean;
  loop?: boolean;
  playback?: 'mix' | 'stems' | null;
  /** Reject a longer composition; this does not trim the theme. */
  maxDurationSeconds?: number;
}
export interface PlanRequest {
  gameBrief: GameBrief;
  eventContract: EventContract;
  options?: { seed?: number };
  audioRequests?: (SfxRequest | MusicRequest)[] | null;
  delivery?: DeliveryRequest;
}

export interface PlannedItemBase {
  id: ItemId;
  required: boolean;
  formatId: FormatId;
  sampleRate: 48000;
  bitrateKbps: 32 | 48 | 64 | 96;
}
export interface SfxItem extends PlannedItemBase {
  kind: 'sfx';
  eventId: string;
  cue: CueId;
  maxRatePerSecond: number | null;
  variants: number;
  channels: 1;
  spatial: Spatial;
  estimatedDurationSeconds: number;
}
export interface MusicItem extends PlannedItemBase {
  kind: 'music';
  scene: string;
  loop: boolean;
  playback: 'mix' | 'stems';
  variants: 1;
  channels: 2;
  durationSeconds: number;
  contentPolicy: 'shared-theme-per-plan';
}

export interface ScoreEvent { beat: number; durationBeats: number; midi: number; velocity: number }
export interface ScoreTrack {
  id: string;
  instrument: 'marimba' | 'fmBell' | 'softKeys' | 'pad' | 'bass' | 'lead' | 'pluck' | 'kick' | 'snare' | 'hat' | 'shaker';
  role: 'lead' | 'harmony' | 'bass' | 'drums' | 'ornament' | 'pad' | 'theme';
  pan: number;
  gainDb: number;
  events: ScoreEvent[];
}
export interface SourceScore {
  bpm: number;
  bars: number;
  meter: number;
  duration: number;
  tracks: ScoreTrack[];
  brief: JsonObject;
  pipeline: GameIdentity & { schemaVersion: 1; planId: string; compilerVersion: string; soundBankVersion: string };
  statistics?: JsonObject;
  [metadata: string]: unknown;
}
export interface SourcePlan extends GameIdentity {
  schemaVersion: 1;
  kind: 'game-audio-plan';
  /** Source compiler identity; different from DeliveryPlan.planId. */
  planId: string;
  seed: number;
  compilerVersion: string;
  composerVersion: string;
  soundBankVersion: string;
  director: JsonObject;
  gameBrief: GameBrief;
  eventContract: EventContract;
  audioSpec: JsonObject;
  score: SourceScore;
  scoreHash: Sha256;
  bindings: Record<string, { cue: CueId; required: boolean; maxRatePerSecond: number | null }>;
  unmappedOptionalEvents: string[];
  mediaStatus: 'not-rendered';
}
export type AlgorithmIdentity =
  | { kind: 'local-rule-based'; version: 'seeded-v1' }
  | { kind: 'configured-algorithm-module'; version: string; sourceHash: Sha256 }
  | { kind: 'openai-compatible'; version: 'style-direction-v1'; model: string; endpointHash: Sha256 };
export interface DeliveryPlan {
  schemaVersion: 1;
  kind: 'audio-delivery-plan';
  identity: GameIdentity;
  sourcePlan: SourcePlan;
  items: (SfxItem | MusicItem)[];
  delivery: Delivery;
  estimates: {
    maxTransferBytes: number;
    decodedPcmBytes: number;
    requiredTransferBytes: number;
    requiredDecodedPcmBytes: number;
    accuracy: 'conservative-estimate-not-measurement';
  };
  versions: { service: 'audio-service-v1'; sourceHashes: Record<string, Sha256>; algorithm: AlgorithmIdentity };
  /** Digest excludes planId, planDigest and status. */
  planDigest: Sha256;
  planId: PlanId;
  status: 'awaiting-confirmation';
}

export interface ConfirmJobRequest {
  planId: PlanId;
  planDigest: Sha256;
  identity: GameIdentity;
  acceptedItems: ItemId[];
  /** Copy the complete normalized object from the returned plan. */
  delivery: Delivery;
}
export interface RetryJobRequest extends ConfirmJobRequest { retryItems?: ItemId[] }
export interface AudioError { code: string; message: string; retryable: boolean; componentId?: string }
export interface ErrorResponse { error: AudioError }
export interface PlanResponse { plan: DeliveryPlan }
export interface JobResponse { job: AudioJob }
/** POST jobs/retry returns 202 for new work, 200 for an idempotent replay. */
export interface SubmitJobResponse extends JobResponse { replayed: boolean }
export type JobStatus = 'queued' | 'rendering' | 'ready' | 'partial-ready' | 'failed' | 'cancelled';
export type ComponentStatus = 'queued' | 'rendering' | 'ready' | 'failed' | 'cancelled';
export interface JobComponent {
  id: ItemId;
  kind: 'sfx' | 'music';
  required: boolean;
  status: ComponentStatus;
  attempts: number;
  cacheHit: boolean;
  error?: AudioError;
  fileCount?: number;
}
export interface MeasuredBudget {
  transferBytes: number;
  decodedPcmBytes: number;
  maxTransferBytes: number;
  maxDecodedPcmBytes: number;
  /** Media + provenance bytes, actual decoded Float32 frames. Excludes manifest transport. */
  measurement: string;
}
export interface AudioJob {
  id: JobId;
  jobId: JobId;
  status: JobStatus;
  statusUrl: string;
  planId: PlanId;
  planDigest: Sha256;
  identity: GameIdentity;
  selectionDigest: Sha256;
  acceptedItems: ItemId[];
  delivery: Delivery;
  components: JobComponent[];
  requiredReady: boolean;
  allSelectedReady: boolean;
  progress: { ready: number; total: number; failed: number };
  packageId: Sha256 | null;
  manifestUrl: string | null;
  /** Alias of manifestUrl, not an archive endpoint. */
  packageUrl: string | null;
  filesBaseUrl: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  retryOf?: JobId;
  retryItems?: ItemId[];
  recoveredAt?: string;
  budget?: MeasuredBudget;
}

export interface Loop {
  enabled: boolean;
  referenceSampleRate: 48000;
  /** Valid master interval [startFrame, endFrame), end is exclusive. */
  startFrame: number;
  endFrame: number;
}
export interface FileBase { id: FileId; path: string; sha256: Sha256; bytes: number; mimeType: string; decodedPcmBytes: number }
export interface AudioFile extends FileBase {
  itemId: ItemId;
  kind: 'sfx' | 'music';
  formatId: FormatId;
  container: 'ogg' | 'mp4';
  codec: 'opus' | 'aac-lc';
  sampleRate: 48000;
  channels: 1 | 2;
  /** Effective valid master frames. decodedFrames can include trailing AAC padding. */
  frames: number;
  decodedFrames?: number;
  durationSeconds?: number;
  encoding: { encoder: string; version: string; targetBitrateKbps: number; rateControl: 'vbr' | 'target-bitrate'; profile?: string | null };
  trim?: { referenceSampleRate: 48000; masterFrames: number; leadingPaddingFrames: 0; trailingPaddingFrames: number; startFrame: 0; endFrame: number; decodedFrames: number; priming: string };
  loop?: Loop;
  group?: 'mix' | 'core' | 'texture' | 'rhythm';
  quality?: JsonObject;
  master?: { sha256: Sha256; frames: number; format: 'wav-float32'; sourceTrim?: JsonObject };
}
export interface ProvenanceFile extends FileBase {
  kind: 'provenance';
  mimeType: 'text/plain; charset=utf-8' | 'application/json';
  decodedPcmBytes: 0;
}
export interface SfxMapping { eventId: string; variants: FileId[]; maxRatePerSecond?: number | null; spatial?: Spatial }
export type MusicMapping = { scene: string; gainDb: number; loop: Loop } & (
  | { mixFileId: FileId; stemFileIds?: never; stemRoles?: never; stemGainDb?: never }
  | { mixFileId?: never; stemFileIds: FileId[]; stemRoles?: Record<FileId, 'core' | 'texture' | 'rhythm'>; stemGainDb?: Record<FileId, number> }
);
export interface ComponentQuality {
  technical: 'passed';
  binding: 'contract-validated';
  listening: 'not-evaluated';
  checks?: string[];
  [metadata: string]: unknown;
}
export interface MediaManifest {
  schemaVersion: 1;
  kind: 'audio-media-package';
  identity: GameIdentity;
  planId: PlanId;
  planDigest: Sha256;
  selectionDigest: Sha256;
  acceptedItems: ItemId[];
  deliveredItems: ItemId[];
  requiredReady: boolean;
  allSelectedReady: boolean;
  delivery: Delivery;
  /** Includes two non-audio provenance files. Decode only MIME audio/ entries. */
  files: (AudioFile | ProvenanceFile)[];
  sfx: Record<ItemId, SfxMapping>;
  music: Record<ItemId, MusicMapping>;
  provenance: { licensesPath: 'provenance/LICENSES.txt'; assetsPath: 'provenance/assets.json' };
  quality: { technical: 'passed'; binding: 'contract-validated-gameplay-not-evaluated'; listening: 'not-evaluated'; components: Record<ItemId, ComponentQuality> };
  budget: MeasuredBudget;
  /** SHA256(canonicalJson(manifest without packageId)). Not a source plan ID. */
  packageId: Sha256;
}

export type FormatDescriptor =
  | { id: 'opus-ogg'; container: 'ogg'; codec: 'opus'; extension: '.ogg'; mimeType: string; sampleRate: 48000 }
  | { id: 'aac-lc-m4a'; container: 'mp4'; codec: 'aac-lc'; extension: '.m4a'; mimeType: string; sampleRate: 48000 };
export interface DirectorInfo {
  kind: 'local-rule-based-research-prototype' | 'configured-algorithm-module' | 'openai-compatible';
  modelConnected: boolean;
  version?: string;
  model?: string;
  scope?: string;
}
export interface RendererStatus { ready: boolean; available?: boolean; renderer?: JsonObject; encoding?: JsonObject; reason?: string; [metadata: string]: unknown }
export interface HealthResponse {
  schemaVersion: 1;
  serviceVersion: 'audio-service-v1';
  status: 'ok' | 'degraded';
  renderer: RendererStatus;
  director: DirectorInfo;
  persistence: 'local-filesystem-single-service-process';
}
export interface CapabilitiesResponse {
  schemaVersion: 1;
  apiVersion: 'v1';
  serviceVersion: 'audio-service-v1';
  formats: FormatDescriptor[];
  profiles: ('cozy' | 'neon' | 'ruins')[];
  spatialCapability: 'optional-HRTF-distance-panning-without-occlusion';
  legacyBridgeSpatialCapability: 'stereo-pan-only';
  musicPolicy: 'shared-theme-per-plan';
  director: DirectorInfo;
  renderer: RendererStatus;
  limits: { requestBytes: 262144; items: 32; events: 64; variants: 3; musicSlots: 4; durationSeconds: 65; maxTransferBytes: 67108864; maxDecodedPcmBytes: 268435456 };
}

export interface RequestOptions {
  method?: string;
  body?: JsonValue | PlanRequest | ConfirmJobRequest | RetryJobRequest;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  binary?: boolean;
  maxBytes?: number;
  timeout?: number;
}
export interface VerifyOptions { expectedIdentity?: Partial<GameIdentity>; planId?: PlanId; planDigest?: Sha256; selectionDigest?: Sha256 }
export interface DownloadProgress { fileId: FileId; path: string; completedBytes: number; totalBytes: number; completedFiles: number; totalFiles: number; cacheHit: boolean }
export interface DownloadOptions extends VerifyOptions {
  signal?: AbortSignal;
  audioContext?: BaseAudioContext;
  decode?: boolean;
  onProgress?: (progress: DownloadProgress) => void;
  /** Required when passing a manifest object, rather than its URL. */
  fileBaseUrl?: string | URL;
  transferBudget?: number;
  decodedBudget?: number;
}
export interface AudioBundle {
  manifest: MediaManifest;
  files: Map<FileId, ArrayBuffer>;
  decoded: Map<FileId, AudioBuffer>;
  transferBytes: number;
  decodedPcmBytes: number;
  verified: true;
}
export interface ClientOptions {
  baseUrl?: string | URL;
  /** Operator-configured Bearer credentials; this service does not issue tokens. */
  token?: string | null | (() => string | null | Promise<string | null>);
  fetchImpl?: typeof fetch;
  persistentCache?: boolean;
  timeoutMs?: number;
  maxTransferBytes?: number;
  maxDecodedPcmBytes?: number;
}
export interface AudioServiceClient {
  request<T = unknown>(path: string | URL, options?: RequestOptions): Promise<T>;
  getHealth(options?: RequestOptions): Promise<HealthResponse>;
  getCapabilities(options?: RequestOptions): Promise<CapabilitiesResponse>;
  probeFormats(options: { audioContext: BaseAudioContext; formats?: FormatDescriptor[]; signal?: AbortSignal }): Promise<{ acceptedFormats: FormatId[]; results: { formatId: FormatId; accepted: boolean; probe: 'native-decodeAudioData' }[] }>;
  createPlan(input: PlanRequest, options?: RequestOptions): Promise<DeliveryPlan>;
  getPlan(id: PlanId, options?: RequestOptions): Promise<DeliveryPlan>;
  /** SDK unwraps {job,replayed}; raw HTTP preserves that envelope. */
  submitJob(plan: DeliveryPlan, options?: { acceptedItems?: ItemId[]; delivery?: Delivery; idempotencyKey?: string; signal?: AbortSignal }): Promise<AudioJob>;
  getJob(id: JobId, options?: RequestOptions): Promise<AudioJob>;
  cancelJob(id: JobId, options?: RequestOptions): Promise<AudioJob>;
  retryJob(id: JobId, options?: { signal?: AbortSignal; idempotencyKey?: string; retryItems?: ItemId[]; job?: AudioJob }): Promise<AudioJob>;
  waitForJob(id: JobId, options?: { signal?: AbortSignal; onUpdate?: (job: AudioJob) => void | Promise<void>; intervalMs?: number; timeoutMs?: number; until?: 'all' | 'required' }): Promise<AudioJob>;
  getManifest(path: string | URL, options?: VerifyOptions & RequestOptions): Promise<MediaManifest>;
  downloadPackage(input: string | URL | MediaManifest, options?: DownloadOptions): Promise<AudioBundle>;
  decodePackage(bundle: AudioBundle, audioContext: BaseAudioContext, options?: VerifyOptions & { signal?: AbortSignal; decodedBudget?: number }): Promise<AudioBundle>;
  dispose(): Promise<void>;
  clearMemoryCache(): void;
  readonly cacheStats: { files: number; decoded: number; manifests: number; encodedBytes: number; decodedBytes: number; manifestBytes: number; maxEncodedBytes: number; maxDecodedBytes: number };
}
export type AudioServiceClientFactory = (options?: ClientOptions) => AudioServiceClient;
export interface AudioServiceError extends Error { code: string; retryable: boolean; componentId?: string; status?: number; toJSON(): ErrorResponse }
export type AudioMemoryCacheConfiguration = { maxEncodedBytes?: number; maxDecodedBytes?: number };
export type ConfigureAudioMemoryCache = (options?: AudioMemoryCacheConfiguration) => Required<AudioMemoryCacheConfiguration>;
export type VerifyManifest = (manifest: MediaManifest, options?: VerifyOptions) => Promise<MediaManifest>;
export type ValidateManifest = (manifest: MediaManifest, options?: VerifyOptions) => MediaManifest;
export type VerifyIdentity = (expected: Partial<GameIdentity> | undefined, actual: GameIdentity) => void;
export type HashBytes = (bytes: BufferSource) => Promise<Sha256>;

export interface Vector3 { x: number; y: number; z: number }
export interface ListenerPose { position: Vector3; forward?: Vector3; up?: Vector3 }
export interface PlaybackPayload { strength?: number; pan?: number; position?: Vector3 }
export type ActionResult<T extends object = Record<never, never>> = ({ accepted: true } & T) | { accepted: false; reason: string; [detail: string]: unknown };
export interface PlayerOptions { audioContext?: AudioContext | null; maxVoices?: number; maxEventsPerSecond?: number; onEvent?: (event: ActionResult) => void; onError?: (error: ActionResult) => void }
export interface PlayerState {
  disposed: boolean; unlocked: boolean; contextState: AudioContextState | 'uninitialized'; muted: boolean; paused: boolean;
  intensity: number; scene: unknown; musicPlaying: boolean; musicItemId: ItemId | null; musicOffset: number;
  activeVoices: number; musicSources: number; eventCount: number; packageId: Sha256 | null; loadedFiles: number;
  eventIds: string[]; musicIds: ItemId[]; spatialCapability: 'HRTF-distance-panning-without-occlusion'; listenerPose: Required<ListenerPose>;
}
export interface AudioPackagePlayer {
  /** Must be called from an explicit user gesture; media preparation can happen first. */
  unlock(): Promise<ActionResult>;
  load(bundle: AudioBundle): ActionResult<{ packageId: Sha256; eventIds: string[]; musicIds: ItemId[] }>;
  play(eventId: string, payload?: PlaybackPayload): ActionResult<{ eventId: string; itemId: ItemId; fileId: FileId; variant: number }>;
  emit(eventId: string, payload?: PlaybackPayload): ReturnType<AudioPackagePlayer['play']>;
  setIntensity(value: number): ActionResult<{ intensity: number }>;
  setListener(pose: ListenerPose): ActionResult<{ capability: 'HRTF-distance-panning-without-occlusion' }>;
  setScene(scene: string): ActionResult<{ scene: string; musicTransition: 'explicit-only' }>;
  pause(): ActionResult;
  resume(): Promise<ActionResult>;
  setMuted(value: boolean): ActionResult<{ muted: boolean }>;
  mute(value?: boolean): ActionResult<{ muted: boolean }>;
  stop(): ActionResult;
  music: { play(itemId: ItemId, options?: { offset?: number }): ActionResult<{ itemId: ItemId; stems: number }>; stop(): ActionResult };
  getState(): PlayerState;
  dispose(): Promise<ActionResult>;
}
export type AudioPackagePlayerFactory = (options?: PlayerOptions) => AudioPackagePlayer;
