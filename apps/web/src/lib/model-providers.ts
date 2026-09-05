/**
 * Which company published a model — derived from its id, never guessed.
 *
 * Why this is not trivial: neither upstream tells us directly.
 *   - Virtuals puts a `"Provider: Model"` prefix in `name`, but 25 of its 191
 *     rows have no prefix at all, and it labels the same publisher two ways
 *     (`x-ai-grok-4-6` is "SpaceXAI", `x-ai-grok-4-20` is "xAI").
 *   - Venice sets `owned_by: "venice.ai"` on all 113 rows, which identifies the
 *     host, not the publisher.
 *
 * So the id is the primary signal and the name prefix is only a fallback. Every
 * pattern below was matched against the live catalogs on 2026-09-04, not assumed.
 *
 * A model that matches nothing resolves to `unknown` and renders a neutral
 * monogram. That is deliberate: showing a company's mark on a model they did not
 * publish is a false claim about provenance, and "I don't know" is the correct
 * answer when the catalog does not say. `inkling` and the `olafangensan-*`
 * community fine-tune land here today.
 */

export interface ModelProvider {
  /** Stable slug — also the `public/models/<id>.svg` filename when `mark` is true. */
  id: string;
  label: string;
  /** Matches the rendered mark so the tile tint and the glyph agree. */
  accent: string;
  /** Rendered when `mark` is false. */
  monogram: string;
  /**
   * Whether `public/models/<id>.svg` exists. simple-icons ships no OpenAI or xAI
   * mark, and none exists for Venice, AION, Nous or Inception, so those render a
   * monogram. Hand-drawing a company's logo from memory would put an inaccurate
   * mark next to a real model — the monogram says "no mark" instead of guessing.
   */
  mark: boolean;
}

const PROVIDERS = {
  openai:     { id: "openai",     label: "OpenAI",        accent: "#10A37F", monogram: "OA", mark: false },
  anthropic:  { id: "anthropic",  label: "Anthropic",     accent: "#D97757", monogram: "AN", mark: true  },
  google:     { id: "google",     label: "Google",        accent: "#8E75B2", monogram: "GO", mark: true  },
  deepseek:   { id: "deepseek",   label: "DeepSeek",      accent: "#5786FE", monogram: "DS", mark: true  },
  xai:        { id: "xai",        label: "xAI",           accent: "#E5E7EB", monogram: "XA", mark: false },
  zai:        { id: "zai",        label: "Z.ai",          accent: "#C3C3C3", monogram: "ZA", mark: true  },
  qwen:       { id: "qwen",       label: "Alibaba Qwen",  accent: "#A394F5", monogram: "QW", mark: true  },
  moonshot:   { id: "moonshot",   label: "Moonshot AI",   accent: "#FFFFFF", monogram: "KI", mark: true  },
  minimax:    { id: "minimax",    label: "MiniMax",       accent: "#F187A2", monogram: "MX", mark: true  },
  meta:       { id: "meta",       label: "Meta",          accent: "#6FA8ED", monogram: "ME", mark: true  },
  mistral:    { id: "mistral",    label: "Mistral",       accent: "#FB8354", monogram: "MI", mark: true  },
  nvidia:     { id: "nvidia",     label: "NVIDIA",        accent: "#76B900", monogram: "NV", mark: true  },
  venice:     { id: "venice",     label: "Venice",        accent: "#F59E0B", monogram: "VE", mark: false },
  aion:       { id: "aion",       label: "AION Labs",     accent: "#C084FC", monogram: "AI", mark: false },
  nous:       { id: "nous",       label: "Nous Research", accent: "#94A3B8", monogram: "NO", mark: false },
  xiaomi:     { id: "xiaomi",     label: "Xiaomi",        accent: "#FF6900", monogram: "XI", mark: true  },
  bytedance:  { id: "bytedance",  label: "ByteDance",     accent: "#3C8CFF", monogram: "BD", mark: true  },
  inception:  { id: "inception",  label: "Inception",     accent: "#94A3B8", monogram: "IC", mark: false },
  unknown:    { id: "unknown",    label: "Unknown",       accent: "#64748B", monogram: "?",  mark: false },
} as const satisfies Record<string, ModelProvider>;

export const UNKNOWN_PROVIDER: ModelProvider = PROVIDERS.unknown;

/**
 * Id prefixes → publisher. Anchored at the start, so a fine-tune published by
 * someone else (`olafangensan-glm-…`, `hermes-3-llama-…`) is attributed to its
 * actual publisher rather than to the base model's owner.
 */
const ID_PREFIXES: ReadonlyArray<readonly [string, ModelProvider]> = [
  ["openai-", PROVIDERS.openai], ["gpt-", PROVIDERS.openai],
  ["anthropic-", PROVIDERS.anthropic], ["claude-", PROVIDERS.anthropic],
  ["google-", PROVIDERS.google], ["gemini-", PROVIDERS.google], ["gemma-", PROVIDERS.google],
  ["deepseek", PROVIDERS.deepseek],
  ["x-ai-", PROVIDERS.xai], ["grok-", PROVIDERS.xai],
  ["z-ai-", PROVIDERS.zai], ["zai-", PROVIDERS.zai], ["glm-", PROVIDERS.zai],
  ["qwen", PROVIDERS.qwen],
  ["moonshotai-", PROVIDERS.moonshot], ["kimi-", PROVIDERS.moonshot],
  ["minimax", PROVIDERS.minimax],
  ["meta-", PROVIDERS.meta], ["llama-", PROVIDERS.meta],
  ["mistral", PROVIDERS.mistral],
  ["nvidia-", PROVIDERS.nvidia],
  ["venice-", PROVIDERS.venice],
  ["aion-", PROVIDERS.aion],
  ["hermes-", PROVIDERS.nous],
  ["xiaomi-", PROVIDERS.xiaomi],
  ["seed-", PROVIDERS.bytedance],
  ["mercury-", PROVIDERS.inception],
];

/** Virtuals' `"Provider: Model"` prefixes, including the two it spells differently. */
const NAME_PREFIXES: Readonly<Record<string, ModelProvider>> = {
  openai: PROVIDERS.openai,
  anthropic: PROVIDERS.anthropic,
  google: PROVIDERS.google,
  deepseek: PROVIDERS.deepseek,
  xai: PROVIDERS.xai,
  spacexai: PROVIDERS.xai,
  "z.ai": PROVIDERS.zai,
  minimax: PROVIDERS.minimax,
  moonshotai: PROVIDERS.moonshot,
  qwen: PROVIDERS.qwen,
  alibaba: PROVIDERS.qwen,
  meta: PROVIDERS.meta,
  mistral: PROVIDERS.mistral,
  nvidia: PROVIDERS.nvidia,
};

export function resolveProvider(modelId: string, name?: string | null): ModelProvider {
  // `e2ee-` is Venice's confidential-compute wrapper, not a publisher: the model
  // underneath `e2ee-deepseek-v4-flash` is still DeepSeek's.
  const id = modelId.toLowerCase().replace(/^e2ee-/, "");

  for (const [prefix, provider] of ID_PREFIXES) {
    if (id.startsWith(prefix)) return provider;
  }

  const sep = name?.indexOf(": ") ?? -1;
  if (name && sep > 0) {
    const fromName = NAME_PREFIXES[name.slice(0, sep).toLowerCase()];
    if (fromName) return fromName;
  }

  return PROVIDERS.unknown;
}
