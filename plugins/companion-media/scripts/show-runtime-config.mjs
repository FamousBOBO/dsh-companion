import { loadConfig } from '../config.mjs';

// Print exactly what the plugin's own loader sees at runtime, so a stale doc
// claim can be told apart from the live value.
const { config, source, missing, error } = loadConfig('C:/Users/bobo/Documents/Bot/dsh-companion');
console.log(JSON.stringify({
  source,
  missing,
  error: error ?? null,
  capabilities: {
    vision: config.vision.enabled,
    speech: config.speech.enabled,
    image: config.image.enabled,
    screen: config.screen.enabled,
  },
  image: {
    allowRealGeneration: config.image.allowRealGeneration,
    model: config.image.model,
    flow: config.image.generationFlow,
    quotas: config.image.quotas,
  },
  style: {
    applyDefaults: config.image.style?.applyDefaults,
    promptChars: config.image.style?.defaultPrompt?.length ?? 0,
    negativeChars: config.image.style?.defaultNegative?.length ?? 0,
  },
  delivery: config.delivery.mode,
}, null, 2));
