/**
 * Props and hook shared by all four skin shells. A skin receives only the app
 * store, its snapshot, the selected skin and the two skin-level settings.
 */
import type { AppSnapshot, AppStore } from "../app/state";
import { useSkinActions } from "./shared";
import { useFormattingState, type FormattingState } from "./formatting";
import type { MenuContext } from "./menus";
import type { SkinId, Theme } from "./skin";
import type { SkinActions } from "./actions";

export interface SkinProps {
  store: AppStore;
  snapshot: AppSnapshot;
  skin: SkinId;
  theme: Theme;
  onSkinChange(skin: SkinId): void;
  onThemeChange(theme: Theme): void;
}

export function useSkinContext(props: SkinProps): {
  actions: SkinActions;
  state: FormattingState;
  menu: MenuContext;
} {
  const actions = useSkinActions(props.store);
  const state = useFormattingState(props.store, props.snapshot);
  return {
    actions,
    state,
    menu: {
      actions,
      state,
      snapshot: props.snapshot,
      skin: props.skin,
      theme: props.theme,
      onSkinChange: props.onSkinChange,
      onThemeChange: props.onThemeChange,
    },
  };
}
