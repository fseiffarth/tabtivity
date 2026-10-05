// The terminal palette for each of the desktop's themes, shared by the
// desktop panes (`TerminalView`) and the phone's terminal (`mobile-web`), so a
// terminal reads as part of whichever theme it sits in. Takes a resolved scheme:
// "system" must be resolved first (desktop: `stores/settings.resolveTheme`;
// phone: `theme.resolvePhoneTheme`). Anything unknown gets the Fancy Dark palette.

export function terminalPalette(scheme: string | undefined) {
  if (scheme === "soft_dark") {
    // The neutral dark theme: background/foreground match its own
    // --bg-main/--text-primary exactly (the achromatic pair's rule below),
    // with a GitHub-dimmed-style ANSI ramp — muted enough not to glow against
    // the gray ground, still unmistakably coloured (they are not chrome).
    return {
      background: "#17181c",
      foreground: "#e8eaf0",
      cursor: "#e8eaf0",
      cursorAccent: "#17181c",
      // A step brighter than the surrounding chrome would suggest: the
      // selection has to read through an agent TUI's own tinted blocks.
      selectionBackground: "#4a5570",
      selectionForeground: "#e8eaf0",
      black: "#4a4f5a",
      red: "#f47067",
      green: "#57ab5a",
      yellow: "#c69026",
      blue: "#6c9bf0",
      magenta: "#b083f0",
      cyan: "#39c5cf",
      white: "#b4bac5",
      brightBlack: "#6e7480",
      brightRed: "#ff938a",
      brightGreen: "#6bc46d",
      brightYellow: "#daaa3f",
      brightBlue: "#86b3f7",
      brightMagenta: "#c89bf5",
      brightCyan: "#56d4dd",
      brightWhite: "#e8eaf0",
    };
  }
  if (scheme === "light_lavender") {
    // Neutral slots form a wide lavender ramp (not grey) so Claude Code's ANSI
    // theme reads as lavender with strong contrast: `black` is a deep saturated
    // lavender for the emphasized sent-message block / removed-diff background,
    // `brightBlack` a clearly lighter lavender for dimmed previous messages /
    // added-diff background, and `white` a light lavender for borders/dim text.
    // The gap between black↔brightBlack↔white is deliberately large so the
    // states are easy to tell apart. green/red are kept saturated so the +/-
    // diff markers stay legible on top of the lavender line backgrounds.
    // selection* + cursorAccent are set (xterm otherwise defaults them to a
    // blue-grey) so selection/cursor also pick up the lavender hue.
    return {
      background: "#faf9fe",
      foreground: "#2c2348",
      cursor: "#7c5cdb",
      cursorAccent: "#faf9fe",
      selectionBackground: "#dccff2",
      selectionForeground: "#241d38",
      black: "#2f2358",
      red: "#d1242f",
      green: "#0f5a26",
      yellow: "#9a6700",
      blue: "#0969da",
      magenta: "#7c5cdb",
      cyan: "#1b7c83",
      white: "#cbc0ec",
      brightBlack: "#8878c4",
      brightRed: "#cf222e",
      brightGreen: "#1c7a39",
      brightYellow: "#bf8700",
      brightBlue: "#0550ae",
      brightMagenta: "#b48cf0",
      brightCyan: "#3192aa",
      brightWhite: "#2c2348",
    };
  }
  // The two achromatic themes (see "The two achromatic themes" in themes.css)
  // get their own terminal palettes rather than sharing the tinted ones below,
  // for the reason a terminal always needs its own: the pane is the largest
  // single surface in the window, so a terminal on #0d1117 inside a window on
  // #000000 does not read as a slightly different black — it reads as a panel
  // someone forgot to style. Background and foreground therefore match the
  // theme's own --bg-main/--text-primary exactly.
  //
  // The sixteen ANSI slots stay COLOURED, and that is the same rule the tokens
  // follow: they are not chrome. A terminal's red and green are a diff's - and
  // +, a test run's fail and pass, an agent's error — meaning the program chose,
  // which the theme has no standing to overrule. What is neutral in the palette
  // is only what was already neutral: the black/white ramp, re-spaced so its
  // four steps stay distinct against a pure ground (on #000000 the old dim grey
  // sat too close to the background, and dimmed text in an agent TUI is a whole
  // tier of its output).
  if (scheme === "light") {
    return {
      background: "#ffffff",
      foreground: "#000000",
      cursor: "#000000",
      cursorAccent: "#ffffff",
      selectionBackground: "#cfcfcf",
      selectionForeground: "#000000",
      black: "#000000",
      red: "#d1242f",
      green: "#1a7f37",
      yellow: "#9a6700",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#767676",
      brightBlack: "#4d4d4d",
      brightRed: "#cf222e",
      brightGreen: "#2da44e",
      brightYellow: "#bf8700",
      brightBlue: "#0550ae",
      brightMagenta: "#6639ba",
      brightCyan: "#3192aa",
      brightWhite: "#000000",
    };
  }
  if (scheme === "dark") {
    return {
      background: "#000000",
      foreground: "#ffffff",
      cursor: "#ffffff",
      cursorAccent: "#000000",
      selectionBackground: "#4d4d4d",
      selectionForeground: "#ffffff",
      black: "#5a5a5a",
      red: "#f85149",
      green: "#3fb950",
      yellow: "#e3b341",
      blue: "#388bfd",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#cccccc",
      brightBlack: "#8a8a8a",
      brightRed: "#ff7b72",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#58a6ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#39c5cf",
      brightWhite: "#ffffff",
    };
  }
  if (scheme === "fancy_light") {
    return {
      background: "#ffffff",
      foreground: "#24292f",
      cursor: "#24292f",
      black: "#24292f",
      red: "#d1242f",
      green: "#1a7f37",
      yellow: "#9a6700",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#cf222e",
      brightGreen: "#2da44e",
      brightYellow: "#bf8700",
      brightBlue: "#0550ae",
      brightMagenta: "#6639ba",
      brightCyan: "#3192aa",
      brightWhite: "#24292f",
    };
  }

  return {
    background: "#0d1117",
    foreground: "#e6edf3",
    cursor: "#e6edf3",
    black: "#484f58",
    red: "#f85149",
    green: "#3fb950",
    yellow: "#e3b341",
    blue: "#388bfd",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ff7b72",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#58a6ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#39c5cf",
    brightWhite: "#e6edf3",
  };
}
