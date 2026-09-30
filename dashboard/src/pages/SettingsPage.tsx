import { isDeployedAddress } from '@stellaragent/core/contracts';

const SETTINGS_STORAGE_KEY = 'sa.dashboard.settings';
export type DashboardSettings = { network: string; rpcUrl: string; horizonUrl: string; contractIds: Record<string, string> };

export function loadSettings(): DashboardSettings {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as DashboardSettings) : { network: 'testnet', rpcUrl: '', horizonUrl: '', contractIds: {} };
}

export function saveSettings(settings: DashboardSettings): void {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function invalidContractIds(settings: DashboardSettings): string[] {
  return Object.entries(settings.contractIds).filter(([, id]) => !isDeployedAddress(id)).map(([name]) => name);
}

export function SettingsPage() {
  return <div data-testid="settings-page" />;
}
