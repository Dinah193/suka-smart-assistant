// src/shims/prop-types.js
// Production-safe no-op shim for "prop-types".
// SSA does not rely on runtime PropTypes in production builds.
// This shim prevents Vite/Rollup from failing when prop-types is not installed.

function noop() {
  return null;
}

// Common validator shapes PropTypes.<type>, PropTypes.<type>.isRequired
function makeValidator() {
  const v = noop;
  v.isRequired = noop;
  return v;
}

const PropTypesShim = new Proxy(
  {
    // Some libs call PropTypes.checkPropTypes(...)
    checkPropTypes: noop,

    // Some code uses PropTypes.oneOfType([...]) etc.
    oneOfType: () => makeValidator(),
    oneOf: () => makeValidator(),
    arrayOf: () => makeValidator(),
    objectOf: () => makeValidator(),
    shape: () => makeValidator(),
    exact: () => makeValidator(),

    // Primitives
    any: makeValidator(),
    array: makeValidator(),
    bool: makeValidator(),
    func: makeValidator(),
    number: makeValidator(),
    object: makeValidator(),
    string: makeValidator(),
    node: makeValidator(),
    element: makeValidator(),
    elementType: makeValidator(),
    symbol: makeValidator(),

    // Less common
    instanceOf: () => makeValidator(),
  },
  {
    get(target, prop) {
      // Return any known prop, otherwise return a validator
      if (prop in target) return target[prop];
      return makeValidator();
    },
  }
);

export default PropTypesShim;
export const checkPropTypes = noop;
