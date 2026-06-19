import { builtInThemeModes, type BuiltInThemeMode, type CustomTheme, type ThemeMode } from '../store'

export interface TerminalPalette {
  background: string
  localBackground: string
  foreground: string
  cursor: string
  selectionBackground: string
}

const terminalPalettes: Record<Exclude<ThemeMode, `custom:${string}`>, TerminalPalette> = {
  dark: {
    background: '#1e1e1e',
    localBackground: '#141414',
    foreground: '#d4d4d4',
    cursor: '#569cd6',
    selectionBackground: 'rgba(86,156,214,0.25)',
  },
  light: {
    background: '#ffffff',
    localBackground: '#f8f8f8',
    foreground: '#1f2328',
    cursor: '#0969da',
    selectionBackground: 'rgba(9,105,218,0.22)',
  },
  vscode: {
    background: '#1e1e1e',
    localBackground: '#181818',
    foreground: '#cccccc',
    cursor: '#007acc',
    selectionBackground: 'rgba(0,122,204,0.28)',
  },
  codex: {
    background: '#0d0f0e',
    localBackground: '#090b0a',
    foreground: '#e6ece8',
    cursor: '#30d5a0',
    selectionBackground: 'rgba(48,213,160,0.22)',
  },
  claude: {
    background: '#1b1917',
    localBackground: '#151311',
    foreground: '#ede6dc',
    cursor: '#d97745',
    selectionBackground: 'rgba(217,119,69,0.24)',
  },
}

function hexToRgb(hex: string) {
  const normalized = hex.replace('#', '')
  const value = Number.parseInt(normalized, 16)
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  }
}

export function hexToRgba(hex: string, alpha: number) {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`
}

export function terminalPalette(themeMode: ThemeMode, customTheme?: CustomTheme | null) {
  if (themeMode.startsWith('custom:') && customTheme) {
    return {
      background: hexToRgba(customTheme.colors.terminalBackground, customTheme.terminalBackgroundOpacity),
      localBackground: hexToRgba(customTheme.colors.terminalBackground, customTheme.terminalBackgroundOpacity),
      foreground: customTheme.colors.terminalForeground,
      cursor: customTheme.colors.terminalCursor,
      selectionBackground: hexToRgba(customTheme.colors.accent, 0.28),
    }
  }
  const builtInMode: BuiltInThemeMode = builtInThemeModes.includes(themeMode as BuiltInThemeMode)
    ? themeMode as BuiltInThemeMode
    : 'dark'
  return terminalPalettes[builtInMode]
}

export function themeColorScheme(themeMode: ThemeMode) {
  return themeMode === 'light' ? 'light' : 'dark'
}

export function customThemeCssVars(theme: CustomTheme) {
  const hasBackground = Boolean(theme.backgroundImagePath)
  const panelAlpha = hasBackground ? 0.58 : 1
  return {
    '--c0': hexToRgba(theme.colors.background, panelAlpha),
    '--c1': hexToRgba(theme.colors.surface, panelAlpha),
    '--c2': hexToRgba(theme.colors.surface2, panelAlpha),
    '--c3': hexToRgba(theme.colors.surface3, panelAlpha),
    '--c4': theme.colors.surface3,
    '--b0': 'rgba(255,255,255,0.055)',
    '--b1': 'rgba(255,255,255,0.10)',
    '--b2': 'rgba(255,255,255,0.16)',
    '--t0': theme.colors.text,
    '--t1': theme.colors.textMuted,
    '--t2': theme.colors.textSubtle,
    '--t3': hexToRgba(theme.colors.textSubtle, 0.72),
    '--acc': theme.colors.accent,
    '--red': theme.colors.red,
    '--grn': theme.colors.green,
  }
}
