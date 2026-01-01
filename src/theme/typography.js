// src/theme/typography.js

const typography = {
  fonts: {
    heading: "'DM Serif Display', serif",
    body: "'Inter', sans-serif",
    mono: "'Fira Code', monospace"
  },
  fontSizes: {
    xs: "0.75rem",   // 12px
    sm: "0.875rem",  // 14px
    base: "1rem",    // 16px
    md: "1.125rem",  // 18px
    lg: "1.25rem",   // 20px
    xl: "1.5rem",    // 24px
    "2xl": "1.875rem", // 30px
    "3xl": "2.25rem",  // 36px
    "4xl": "3rem",     // 48px
    "5xl": "4rem",     // 64px
    "6xl": "5rem"      // 80px
  },
  fontWeights: {
    hairline: 100,
    thin: 200,
    light: 300,
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    extrabold: 800,
    black: 900
  },
  lineHeights: {
    normal: "1.5",
    relaxed: "1.625",
    loose: "2",
    snug: "1.375",
    tight: "1.25",
    none: "1"
  },
  letterSpacings: {
    tighter: "-0.05em",
    tight: "-0.025em",
    normal: "0",
    wide: "0.025em",
    wider: "0.05em",
    widest: "0.1em"
  }
};

export default typography;
