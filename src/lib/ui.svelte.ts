// Small bits of screen state shared across components.
const COMPACT = '(orientation: portrait) and (max-width: 960px)';
const SHORT = '(orientation: landscape) and (max-height: 500px)';
const COARSE = '(pointer: coarse)';

export const ui = $state<{
  /** Shown instead of the real balance during a reveal, so the header can't spoil the result. */
  heldBalance: number | null;
  banner: { id: number; title: string; detail: string } | null;
  /** Phone or tablet held upright: one column, and a round fits on one screen. */
  compact: boolean;
  /** Phone held sideways: map and rail side by side, sized to the short height. */
  short: boolean;
  /** Fingers rather than a mouse. */
  coarse: boolean;
  /** Bumped to put the map camera back to showing the whole island. */
  cameraReset: number;
  /** A map pixel the camera should keep in view, such as where the chest landed. */
  focus: { x: number; y: number } | null;
  /** The wallet dialog, if open. `need` is the coins missing for what the player just tried. */
  wallet: { need: number | null } | null;
  /** The how-to-play pop-up. */
  tutorial: boolean;
}>({
  heldBalance: null,
  banner: null,
  compact: matchMedia(COMPACT).matches,
  short: matchMedia(SHORT).matches,
  coarse: matchMedia(COARSE).matches,
  cameraReset: 0,
  focus: null,
  wallet: null,
  tutorial: false,
});

matchMedia(COMPACT).addEventListener('change', (e) => (ui.compact = e.matches));
matchMedia(SHORT).addEventListener('change', (e) => (ui.short = e.matches));
matchMedia(COARSE).addEventListener('change', (e) => (ui.coarse = e.matches));

let bannerId = 0;
let bannerTimer: ReturnType<typeof setTimeout> | undefined;

export function showBanner(title: string, detail: string) {
  clearTimeout(bannerTimer);
  ui.banner = { id: ++bannerId, title, detail };
  bannerTimer = setTimeout(() => (ui.banner = null), 2000);
}

/** A little phone vibration. iPhones don't offer this to web pages, so there it does nothing. */
export function buzz(pattern: number | number[]) {
  navigator.vibrate?.(pattern);
}

export function openWallet(need: number | null = null) {
  ui.wallet = { need };
}
