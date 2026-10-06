import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';

export type AdapterKind = 'linked-device' | 'business-graph';
export type OperationKind = 'read' | 'guarded-mutation';

export interface OperationDefinition {
  adapter: AdapterKind;
  id: string;
  title: string;
  description: string;
  kind: OperationKind;
  inputSchema: AnySchema;
}

export class UnsupportedCapabilityError extends Error {
  readonly code = 'UNSUPPORTED';

  constructor(adapter: AdapterKind, operationId: string) {
    super(`Capability '${operationId}' is not supported by adapter '${adapter}'.`);
    this.name = 'UnsupportedCapabilityError';
  }
}

/**
 * Contains only operations implemented by a concrete adapter. An adapter must
 * not register speculative operations or placeholders in this registry.
 */
export class CapabilityRegistry {
  private readonly operations = new Map<AdapterKind, Map<string, OperationDefinition>>();

  constructor(definitions: readonly OperationDefinition[]) {
    for (const definition of definitions) {
      const adapterOperations = this.operations.get(definition.adapter) ?? new Map();
      if (adapterOperations.has(definition.id)) {
        throw new Error(`Duplicate capability '${definition.id}' for '${definition.adapter}'.`);
      }
      adapterOperations.set(definition.id, Object.freeze({ ...definition }));
      this.operations.set(definition.adapter, adapterOperations);
    }
  }

  list(adapter: AdapterKind): readonly OperationDefinition[] {
    return [...(this.operations.get(adapter)?.values() ?? [])];
  }

  require(adapter: AdapterKind, operationId: string): OperationDefinition {
    const definition = this.operations.get(adapter)?.get(operationId);
    if (!definition) throw new UnsupportedCapabilityError(adapter, operationId);
    return definition;
  }
}
