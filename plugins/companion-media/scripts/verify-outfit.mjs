import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountMedia, apply } from '../index.mjs';

// Prove the wardrobe reaches the image tool and that the caller can see the
// caption that NovelAI actually receives (clothes included).
const live = 'C:/Users/bobo/Documents/Bot/dsh-companion';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-outfit-'));
fs.mkdirSync(path.join(root, 'home/media'), { recursive: true });
fs.mkdirSync(path.join(root, 'home/companion'), { recursive: true });
fs.copyFileSync(path.join(live, 'home/media/config.json'), path.join(root, 'home/media/config.json'));
const wardrobeSource = path.join(live, 'home/companion/wardrobe.json');
if (fs.existsSync(wardrobeSource)) {
  fs.copyFileSync(wardrobeSource, path.join(root, 'home/companion/wardrobe.json'));
}

const registered = [];
const ctx = {
  tools: { register(tool) { registered.push(tool); } },
  systemPrompt: { section() {} },
  get() { return undefined; },
};
mountMedia(ctx, { companionRoot: root });
const service = apply(ctx);

const result = await service.draw({
  prompt: 'March 7th from Honkai: Star Rail, pink hair, blue-to-pink gradient eyes, sitting by the train window at dusk',
  sessionId: 'session-outfit-check',
  dryRun: true,
});
console.log(JSON.stringify({
  ok: result.ok,
  outfit: result.outfit,
  promptTranslation: result.promptTranslation,
  captionTail: typeof result.caption === 'string' ? result.caption.slice(-260) : null,
  error: result.error,
}, null, 2));
