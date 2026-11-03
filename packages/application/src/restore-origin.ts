import type { RestoreOrigin } from '@runnets/domain';
export interface RestoreOriginStore {
  origin(): RestoreOrigin | null;
  /** Write once, before the restored profile is published. Existing provenance is never replaced. */
  install(origin: RestoreOrigin): void;
}
