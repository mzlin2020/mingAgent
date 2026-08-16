/**
 * 设置中心开关（M3.5-e，ADR-0075）。
 *
 * 不是第三主视图：打开设置不改 `shellView`，会话不被打断。
 */
export interface SettingsSlice {
  settingsOpen: boolean;
  readonly openSettings: () => void;
  readonly closeSettings: () => void;
}

export function createSettingsSlice(
  set: (partial: Partial<SettingsSlice>) => void,
  refreshStatus: () => Promise<void>,
): SettingsSlice {
  return {
    settingsOpen: false,
    openSettings: () => {
      set({ settingsOpen: true });
      void refreshStatus();
    },
    closeSettings: () => {
      set({ settingsOpen: false });
    },
  };
}
