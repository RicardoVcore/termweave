import type { ProviderInstanceConfigMap } from "@termweave/contracts";
import { Context } from "effect";
import type * as Effect from "effect/Effect";

export interface ProviderInstanceRegistryMutatorShape {
  readonly reconcile: (configMap: ProviderInstanceConfigMap) => Effect.Effect<void>;
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()("termweave-server/provider/Services/ProviderInstanceRegistryMutator") {}
