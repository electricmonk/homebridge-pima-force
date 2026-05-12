/**
 * `ts-byob` builders for the plugin's config blob, as it appears in
 * homebridge's config.json.
 *
 * Tests speak in `aPluginConfig({partitions: [aPartition({id: 1})]})`
 * rather than spelling out the full literal config every time. Defaults
 * mirror the canonical "rich" e2e fixture (E2E Partition + E2E Restricted
 * + four sensor zones + siren), so a test that doesn't override anything
 * gets a sensible default.
 */
import { builderFor } from 'ts-byob';

export type ZoneType = 'contact' | 'motion' | 'leak' | 'smoke';

export interface ZoneConfig {
  zone: number;
  name: string;
  type: ZoneType;
}

export interface PartitionConfig {
  id: number;
  name: string;
  userCode: string;
  /** Optional checkboxes for which HomeKit armed states to expose. */
  armModes?: { away?: boolean; stay?: boolean; night?: boolean };
  /** Legacy: zones nested under a partition. Tests for the migration path use this. */
  zones?: ZoneConfig[];
}

export interface SirenConfig {
  enabled: boolean;
  name?: string;
}

/**
 * Plugin-level config (the fields that appear inside the `PimaForce`
 * platform entry in `config.json`). Tests provide this; the harness adds
 * `platform`, `port`, `account`, and `requestTimeoutMs` itself.
 */
export interface PluginConfig {
  name: string;
  partitions: PartitionConfig[];
  zones?: ZoneConfig[];
  siren?: SirenConfig;
}

// ts-byob's `ctx.next` is 0-indexed. Pima partition ids run 1–16 and zone
// numbers 1–144 (Appendix B/C of the spec); 0 is invalid, so we add 1 to
// keep the auto-counter in the panel-valid range.
export const aPartition = builderFor<PartitionConfig>((ctx) => {
  const n = ctx.next('partition') + 1;
  return {
    id: n,
    name: `Partition ${n}`,
    userCode: '0000',
  };
});

export const aZone = builderFor<ZoneConfig>((ctx) => {
  const n = ctx.next('zone') + 1;
  return {
    zone: n,
    name: `Zone ${n}`,
    type: 'contact',
  };
});

/**
 * Default plugin config used by tests that don't care about the specific
 * shape — one partition and the four sensor types we want HomeKit to
 * expose, plus an external siren. Tests with specific topology requirements
 * (multiple partitions, restricted arm modes, no-zones discovery, etc.)
 * pass their own `aPluginConfig({...overrides})`.
 *
 * The default deliberately does NOT include the "restricted-arm-modes"
 * partition — that's a ui-commands.test.ts concern; not all tests need it.
 */
export const aPluginConfig = builderFor<PluginConfig>(() => ({
  name: 'Pima E2E',
  siren: { enabled: true, name: 'E2E Siren' },
  partitions: [
    aPartition({ id: 2, name: 'E2E Partition' }),
  ],
  zones: [
    aZone({ zone: 3, name: 'E2E Motion', type: 'motion' }),
    aZone({ zone: 4, name: 'E2E Door', type: 'contact' }),
    aZone({ zone: 5, name: 'E2E Leak', type: 'leak' }),
    aZone({ zone: 6, name: 'E2E Smoke', type: 'smoke' }),
  ],
}));
