import type { CapabilityContext } from '../capabilities/session.js';

export type { CapabilityContext } from '../capabilities/session.js';

/** 远端 Agent 只产生外部结论；描述对象不包含真实凭证。 */
export type RemoteAgentSlot = {
  slotId: string;
  agentCardUrl: string;
  role: 'server' | 'external' | 'specialist' | 'domain';
  capabilities: string[];
  authRef: string;
  timeoutMs: number;
  maxOutputChars: number;
  evidenceMode: 'external_findings';
};

export type CapabilityResult = {
  data: unknown;
  truncated: boolean;
  limitations: string[];
  audit?: Record<string, string | number | boolean | null>;
};

export interface AgentSlotAdapter {
  invoke(
    slot: RemoteAgentSlot,
    task: unknown,
    context: CapabilityContext,
  ): Promise<CapabilityResult>;
  cancel(slot: RemoteAgentSlot, taskId: string, context: CapabilityContext): Promise<void>;
}

export interface AgentSlotRegistry {
  resolve(slotId: string, context: CapabilityContext): Promise<RemoteAgentSlot>;
  invoke(
    slot: RemoteAgentSlot,
    task: unknown,
    context: CapabilityContext,
  ): Promise<CapabilityResult>;
  cancel(slot: RemoteAgentSlot, taskId: string, context: CapabilityContext): Promise<void>;
}

export type AgentSlotRegistration = {
  slot: RemoteAgentSlot;
  adapter: AgentSlotAdapter;
  enabled?: boolean;
};

export type AgentSlotRegistryErrorCode =
  | 'unknown_agent_slot'
  | 'duplicate_agent_slot'
  | 'invalid_agent_slot';

export class AgentSlotRegistryError extends Error {
  public constructor(
    readonly code: AgentSlotRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentSlotRegistryError';
  }
}

type ConfiguredSlot = {
  slot: RemoteAgentSlot;
  adapter: AgentSlotAdapter;
  enabled: boolean;
};

/** 进程内配置驱动实现；未启用槽位与未知槽位使用相同的失败语义。 */
export class InMemoryAgentSlotRegistry implements AgentSlotRegistry {
  private readonly configurations = new Map<string, ConfiguredSlot>();

  public constructor(registrations: Iterable<AgentSlotRegistration> = []) {
    for (const registration of registrations) this.register(registration);
  }

  public register(registration: AgentSlotRegistration): void;
  public register(slot: RemoteAgentSlot, adapter: AgentSlotAdapter, enabled?: boolean): void;
  public register(
    registrationOrSlot: AgentSlotRegistration | RemoteAgentSlot,
    adapter?: AgentSlotAdapter,
    enabled = true,
  ): void {
    const registration: AgentSlotRegistration = 'adapter' in registrationOrSlot
      ? registrationOrSlot
      : { slot: registrationOrSlot, adapter: adapter!, enabled };
    const slot = normalizeSlot(registration.slot);
    if (this.configurations.has(slot.slotId)) {
      throw new AgentSlotRegistryError(
        'duplicate_agent_slot',
        `Agent slot already registered: ${slot.slotId}`,
      );
    }
    if (!registration.adapter || typeof registration.adapter.invoke !== 'function' ||
        typeof registration.adapter.cancel !== 'function') {
      throw new AgentSlotRegistryError(
        'invalid_agent_slot',
        `Agent slot adapter is invalid: ${slot.slotId}`,
      );
    }
    this.configurations.set(slot.slotId, {
      slot,
      adapter: registration.adapter,
      enabled: registration.enabled ?? true,
    });
  }

  public setEnabled(slotId: string, enabled: boolean): void {
    this.knownSlot(slotId).enabled = enabled;
  }

  public enable(slotId: string): void {
    this.setEnabled(slotId, true);
  }

  public disable(slotId: string): void {
    this.setEnabled(slotId, false);
  }

  public async resolve(slotId: string, context: CapabilityContext): Promise<RemoteAgentSlot> {
    void context;
    return copySlot(this.activeSlot(slotId).slot);
  }

  public async invoke(
    slot: RemoteAgentSlot,
    task: unknown,
    context: CapabilityContext,
  ): Promise<CapabilityResult> {
    // 始终以注册配置为准，调用方不能临时放大超时或输出上限。
    const configured = this.activeSlot(slot.slotId);
    return configured.adapter.invoke(configured.slot, task, context);
  }

  public async cancel(
    slot: RemoteAgentSlot,
    taskId: string,
    context: CapabilityContext,
  ): Promise<void> {
    // 槽位停用后仍需允许清理已经创建的远端任务。
    const configured = this.knownSlot(slot.slotId);
    return configured.adapter.cancel(configured.slot, taskId, context);
  }

  private knownSlot(slotId: string): ConfiguredSlot {
    const configured = this.configurations.get(slotId.trim());
    if (!configured) throw unknownSlot(slotId);
    return configured;
  }

  private activeSlot(slotId: string): ConfiguredSlot {
    const configured = this.knownSlot(slotId);
    if (!configured.enabled) throw unknownSlot(slotId);
    return configured;
  }
}

function unknownSlot(slotId: string): AgentSlotRegistryError {
  return new AgentSlotRegistryError(
    'unknown_agent_slot',
    `Agent slot is not available: ${slotId.trim()}`,
  );
}

function copySlot(slot: RemoteAgentSlot): RemoteAgentSlot {
  return { ...slot, capabilities: [...slot.capabilities] };
}

function normalizeSlot(slot: RemoteAgentSlot): RemoteAgentSlot {
  if (!slot || typeof slot !== 'object') return invalidSlot('Agent slot must be an object');
  const slotId = slot.slotId?.trim();
  const agentCardUrl = slot.agentCardUrl?.trim();
  const authRef = slot.authRef?.trim();
  if (!slotId) return invalidSlot('Agent slot id is required');
  if (!agentCardUrl || !isHttpUrl(agentCardUrl)) {
    return invalidSlot(`Agent card URL is invalid for slot: ${slotId}`);
  }
  if (!['server', 'external', 'specialist', 'domain'].includes(slot.role)) {
    return invalidSlot(`Agent slot role is invalid: ${slotId}`);
  }
  if (!Array.isArray(slot.capabilities) ||
      slot.capabilities.some((capability) => typeof capability !== 'string' || !capability.trim())) {
    return invalidSlot(`Agent slot capabilities are invalid: ${slotId}`);
  }
  if (!authRef) return invalidSlot(`Agent slot authRef is required: ${slotId}`);
  if (!Number.isFinite(slot.timeoutMs) || slot.timeoutMs <= 0) {
    return invalidSlot(`Agent slot timeoutMs must be positive: ${slotId}`);
  }
  if (!Number.isInteger(slot.maxOutputChars) || slot.maxOutputChars <= 0) {
    return invalidSlot(`Agent slot maxOutputChars must be a positive integer: ${slotId}`);
  }
  if (slot.evidenceMode !== 'external_findings') {
    return invalidSlot(`Agent slot evidenceMode must be external_findings: ${slotId}`);
  }
  return {
    slotId,
    agentCardUrl,
    role: slot.role,
    capabilities: slot.capabilities.map((capability) => capability.trim()),
    authRef,
    timeoutMs: slot.timeoutMs,
    maxOutputChars: slot.maxOutputChars,
    evidenceMode: slot.evidenceMode,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function invalidSlot(message: string): never {
  throw new AgentSlotRegistryError('invalid_agent_slot', message);
}
