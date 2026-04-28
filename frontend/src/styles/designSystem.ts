import type { CSSProperties } from "react";

export const colors = {
  bgMain: "#03060B",
  bgElevated: "rgba(9, 13, 19, 0.68)",
  bgGlass: "rgba(10, 14, 20, 0.82)",

  borderSubtle: "rgba(132, 153, 171, 0.16)",
  borderStrong: "rgba(205, 221, 234, 0.28)",

  textPrimary: "rgba(242, 246, 250, 0.96)",
  textSecondary: "rgba(187, 199, 211, 0.8)",
  textMuted: "rgba(133, 148, 160, 0.64)",

  accent: "#A8D2EB",
  danger: "#E79D84",
  warning: "#D8B372",
  success: "#8EC1B0",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 10,
  md: 22,
  lg: 30,
} as const;

export const typography = {
  title: {
    size: 18,
    weight: 600,
    lineHeight: 1.2,
  },
  section: {
    size: 10,
    weight: 600,
    lineHeight: 1.25,
    letterSpacing: "0.14em",
  },
  value: {
    size: 24,
    weight: 600,
    lineHeight: 1.1,
  },
  body: {
    size: 13,
    weight: 500,
    lineHeight: 1.45,
  },
} as const;

export const motion = {
  easeStandard: [0.22, 1, 0.36, 1] as const,
  durationFast: 0.2,
  durationBase: 0.32,
  tooltipDelayMs: 120,
  uiSyncDelayMs: 110,
} as const;

export const designSystemCssVariables: CSSProperties = {
  "--ds-bg-main": colors.bgMain,
  "--ds-bg-elevated": colors.bgElevated,
  "--ds-bg-glass": colors.bgGlass,
  "--ds-border-subtle": colors.borderSubtle,
  "--ds-border-strong": colors.borderStrong,
  "--ds-text-primary": colors.textPrimary,
  "--ds-text-secondary": colors.textSecondary,
  "--ds-text-muted": colors.textMuted,
  "--ds-accent": colors.accent,
  "--ds-danger": colors.danger,
  "--ds-warning": colors.warning,
  "--ds-success": colors.success,
  "--ds-space-xs": `${spacing.xs}px`,
  "--ds-space-sm": `${spacing.sm}px`,
  "--ds-space-md": `${spacing.md}px`,
  "--ds-space-lg": `${spacing.lg}px`,
  "--ds-space-xl": `${spacing.xl}px`,
  "--ds-space-xxl": `${spacing.xxl}px`,
  "--ds-radius-sm": `${radius.sm}px`,
  "--ds-radius-md": `${radius.md}px`,
  "--ds-radius-lg": `${radius.lg}px`,
  "--ds-font-title": `${typography.title.size}px`,
  "--ds-font-section": `${typography.section.size}px`,
  "--ds-font-value": `${typography.value.size}px`,
  "--ds-font-body": `${typography.body.size}px`,
  "--ds-motion-duration-fast": `${motion.durationFast}s`,
  "--ds-motion-duration-base": `${motion.durationBase}s`,
  "--ds-motion-ease": "cubic-bezier(0.22, 1, 0.36, 1)",
} as CSSProperties;

