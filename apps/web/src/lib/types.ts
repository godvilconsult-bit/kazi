import type {
  HostedAdvice,
  HostedConfig,
  PointsFlag,
  StoredQuote,
  SubtaskStatus,
  TaskStatus,
} from "@kazi/shared";

export type { HostedAdvice, HostedConfig };

/** Response shapes of the Kazi API (apps/api/src/routes/serializers.ts and route handlers). */

export type Address = `0x${string}`;

export interface PublicConfig {
  usdcDecimals: number;
  kaziDecimals: number | null;
  settings: { announcement?: string | null; feeDisplayBps?: number; minStakeDisplay?: string };
  chain: {
    id: number;
    network: "local" | "testnet" | "mainnet";
    name: string;
    rpcUrl: string;
    explorerUrl: string | null;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    minMaxFeePerGasWei: string;
    faucetUrl: string | null;
  };
  contracts: {
    usdc: Address;
    escrow: Address | null;
    agentRegistry?: Address;
    stakingVault?: Address;
    kaziToken?: Address;
    feeDistributor?: Address;
    /** KaziAirdrop, once the token has launched on this network. */
    airdrop?: Address;
    /** KAZI (Argus) ⇄ KAZI Credits exchange, where deployed (docs/08-TOKENOMICS.md §8). */
    creditsGate?: Address;
    /** The KAZI token traded on Argus. */
    argusKazi?: Address;
  };
}

export interface User {
  id: string;
  wallet: Address;
  displayName: string | null;
  roles: ("CLIENT" | "PROVIDER_OWNER" | "FREELANCER" | "ADMIN")[];
  createdAt: string;
}

export interface SubtaskView {
  id: string;
  index: number;
  kind: "WORK" | "SERVICE_FEE";
  title: string;
  capability: string;
  dependsOn: number[];
  providerId: string | null;
  amount: string;
  status: SubtaskStatus;
  attempts: number;
  revisions: number;
  provider: {
    name: string;
    slug: string;
    kind: "AGENT" | "HUMAN";
    hosting: "SELF" | "KAZI";
  } | null;
  releaseTxHash: string | null;
  refundTxHash: string | null;
}

export interface TaskView {
  id: string;
  onchainId: `0x${string}`;
  title: string;
  description: string;
  attachments: string[];
  budgetMax: string | null;
  deadline: string;
  speed: "ECONOMY" | "EXPRESS";
  status: TaskStatus;
  quoteVersion: number;
  totalAmount: string | null;
  feeBps: number | null;
  fundTxHash: string | null;
  deliveredAt: string | null;
  reviewUntil: string | null;
  rating: number | null;
  ratingComment: string | null;
  createdAt: string;
  updatedAt: string;
  subtasks?: SubtaskView[];
}

export type QuoteView =
  | (Extract<StoredQuote, { outcome: "QUOTED" }> & { expired: boolean })
  | Extract<StoredQuote, { outcome: "NEEDS_CLARIFICATION" }>
  | Extract<StoredQuote, { outcome: "INFEASIBLE" }>;

export interface TaskEventView {
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface FundParams {
  escrowAddress: Address;
  usdcAddress: Address;
  quote: {
    taskId: `0x${string}`;
    providerIds: string[];
    amounts: string[];
    deadline: string;
    feeBps: number;
    expiry: string;
  };
  quoteSig: `0x${string}`;
  total: string;
  expiresAt: string;
}

export interface Deliverable {
  index: number;
  title: string;
  status: SubtaskStatus;
  provider: { name: string; slug: string } | null;
  revisions: number;
  score: number | null;
  output: {
    text: string | null;
    files: { fileId: string | null; mime: string; sha256: string }[];
  } | null;
}

export interface Pricing {
  model: "per_unit" | "fixed";
  unit?: string;
  price: string;
  currency: "USDC";
  minimum?: string;
}

export interface ProviderPublic {
  id: string;
  onchainId: string | null;
  kind: "AGENT" | "HUMAN";
  name: string;
  slug: string;
  description: string;
  capabilities: string[];
  languages: string[];
  pricing: Pricing;
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "DELISTED";
  isHouse: boolean;
  hosting: "SELF" | "KAZI";
  stakeAmount: string;
  reputation: number;
  completedCount: number;
  avgLatencyMs: number | null;
  createdAt: string;
}

export interface ProviderOwner extends ProviderPublic {
  endpointUrl: string | null;
  manifestUrl: string | null;
  manifestHash: string | null;
  payoutAddress: Address;
  failedCount: number;
  hasWebhookSecret: boolean;
  hostedConfig: HostedConfig | null;
  aiCostUsd: { economy: string; express: string; samples: number; updatedAt: string } | null;
  hostedAdvice: HostedAdvice | null;
}

export interface ProviderStats {
  completedCount: number;
  failedCount: number;
  successRateBps: number | null;
  reputation: number;
  avgLatencyMs: number | null;
  earningsGross: string;
}

export interface ProviderSubmission {
  id: string;
  attempt: number;
  step: string;
  capability: string;
  amount: string;
  stepStatus: SubtaskStatus;
  score: number | null;
  accepted: boolean | null;
  latencyMs: number | null;
  feedback: string | null;
  createdAt: string;
}

export interface ProviderTestState {
  testId: string;
  providerId: string;
  capability: string;
  status: "QUEUED" | "SENT" | "COMPLETED" | "FAILED";
  createdAt: string;
  updatedAt: string;
  http?: number;
  latencyMs?: number;
  progress?: number;
  output?: { text?: string; files?: { url: string; mime: string }[] };
  error?: { code: string; message: string };
  checks?: { code: string; message: string }[];
}

export interface Offer {
  id: string;
  subtaskId: string;
  status: "OFFERED" | "ACCEPTED";
  wave: number;
  expiresAt: string;
  taskTitle: string;
  title: string;
  capability: string;
  instructions: string;
  acceptance: { rubric?: string[]; format?: string; mustInclude?: string[] };
  payout: string;
  dueAt: string;
  subtaskStatus: SubtaskStatus;
}

export interface FreelancerWork {
  subtask: {
    id: string;
    status: SubtaskStatus;
    attempt: number;
    title: string;
    capability: string;
    instructions: string;
    acceptance: { rubric?: string[]; format?: string; mustInclude?: string[] };
    dueAt: string;
    assigned: boolean;
    feedback: string | null;
  };
  request: { title: string; description: string };
  previousSteps: { title: string; text: string }[];
  files: { id: string; filename: string; mime: string; size: number }[];
}

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface FileView {
  id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string | null;
  status: "PENDING" | "UPLOADED";
  createdAt: string;
}

export interface Capability {
  slug: string;
  description: string;
}

export interface Stats {
  tasksCompleted: number;
  activeAgents: number;
  volume: string;
  topAgents: Pick<
    ProviderPublic,
    | "slug"
    | "name"
    | "kind"
    | "hosting"
    | "capabilities"
    | "pricing"
    | "reputation"
    | "completedCount"
    | "isHouse"
  >[];
}

export interface CalldataTx {
  to: Address;
  data: `0x${string}`;
  value: string;
}

export interface AdminDispute {
  id: string;
  status: "OPEN" | "UNDER_REVIEW" | "RESOLVED";
  reason: string;
  evidence: string[];
  resolution: unknown;
  createdAt: string;
  task: {
    id: string;
    title: string;
    description: string;
    status: TaskStatus;
    clientWallet: Address;
    totalAmount: string | null;
    steps: {
      index: number;
      kind: "WORK" | "SERVICE_FEE";
      title: string;
      status: SubtaskStatus;
      amount: string;
      provider: { name: string; slug: string } | null;
      latest: { output: unknown; score: number | null; evaluation: unknown } | null;
    }[];
  };
}

/* ─── $KAZI (Phase 6): GET /token/metrics, /token/staking, /points/*, /airdrop/:wallet ─── */

export interface FeeSplit {
  treasuryBps: number;
  stakerBps: number;
  buybackBps: number;
}

export interface VestingProgress {
  name: "team" | "ecosystem";
  address: Address;
  total: string;
  vested: string;
  released: string;
  start: number;
  end: number;
}

/** GET /token/kazi-burn: KAZI bought back and burned through its Argus launch (docs/08 §8). */
export type KaziBurn =
  | { available: false }
  | {
      available: true;
      token: Address;
      burnAddress: Address;
      kaziDecimals: number;
      totalSupply: string;
      burned: string;
      burnedBps: number;
      quoteAsset: Address;
      quoteDecimals: number;
      buybackSpent: string;
      buybackPending: string;
      taxCollected: string;
      burnShareBps: number;
      buyTaxBps: number;
      sellTaxBps: number;
    };

export type TokenMetrics =
  | { deployed: false; launched: false }
  | {
      deployed: true;
      launched: boolean;
      tge: number | null;
      totalSupply: string;
      circulating: string;
      staked: string;
      stakedActive: string;
      stakedBps: number;
      stakerRewards: { allTime: string; last30d: string; claimed: string };
      feesDistributed: string;
      split: FeeSplit | null;
      buybackReserved: string;
      treasuryUsdc: string | null;
      vesting: VestingProgress[];
      airdrop: { address: Address; balance: string; claimed: string; deadline: number } | null;
      creditsGate?: {
        address: Address;
        kazi: Address;
        totalLocked: string;
        reserve: string;
        fullyBacked: boolean;
        paused: boolean;
      } | null;
      contracts: Record<string, Address | null>;
    };

export type StakingInfo =
  | { deployed: false }
  | {
      deployed: true;
      rewards30d: string;
      per1000Kazi30d: string;
      totalActive: string;
      warmupSeconds: number;
      cooldownSeconds: number;
      stakerBps: number;
    };

export interface PointsMe {
  total: number;
  entries: {
    taskId: string;
    title: string | null;
    role: "CLIENT" | "PROVIDER";
    points: number;
    flag: PointsFlag | null;
    feeUnits: string;
    at: string;
  }[];
}

export interface PointsLeader {
  rank: number;
  wallet: string;
  points: number;
}

export interface AirdropProof {
  airdropId: string;
  contract: Address;
  amount: string;
  proof: `0x${string}`[];
}
