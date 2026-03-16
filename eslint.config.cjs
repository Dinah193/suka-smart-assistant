module.exports = [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      ".tmp/**",
      "coverage/**",
      "public/**",
      "docs/**",
      "data/**",
      "Infrastructure/**",
      "notes/**",
      "**/*.md",
      "**/*.rtf"
    ],
  },
  {
    files: [
      "tools/scripts/**/*.cjs",
      "src/server/db/adapters/**/*.js",
      "src/services/mongodb/**/*.js",
      "_tests_/**/*.js"
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        module: "readonly",
        require: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        exports: "readonly",
        fetch: "readonly"
      }
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error"
    },
    rules: {}
  }
];
