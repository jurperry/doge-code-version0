// Polyfill for bun:bundle feature() in development mode
// This ensures BUDDY and other features are enabled in doge-code

const originalFeature = globalThis.Bun?.feature;

if (!originalFeature) {
  // Create a mock feature function for development mode
  const enabledFeatures = new Set([
    'BUDDY',  // Always enabled in doge-code
    // Add other features as needed
  ]);

  // Monkey-patch the bun:bundle module
  const Module = require('module');
  const originalRequire = Module.prototype.require;

  Module.prototype.require = function(id) {
    if (id === 'bun:bundle') {
      return {
        feature: (name) => enabledFeatures.has(name)
      };
    }
    return originalRequire.apply(this, arguments);
  };
}
