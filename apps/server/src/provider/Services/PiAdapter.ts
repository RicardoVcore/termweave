/**
 * PiAdapter — shape type for the Pi provider adapter.
 *
 * Like the other adapter shape modules this only anchors the per-instance
 * `ProviderAdapterShape` contract under a provider-specific name; the driver
 * bundle (phase A3) captures one adapter per instance as a closure.
 *
 * @module PiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * PiAdapterShape — per-instance Pi adapter contract. Carries a branded
 * driver kind as the nominal discriminant.
 */
export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
