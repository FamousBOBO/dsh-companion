// Stand-in for the host LLM module used by the memory extraction path.
// Only the streaming helpers the foundation plugin imports are provided; tests inject
// their own fake `llm` service, so this assembler just needs the host's chunk protocol:
// block-start / text-delta / block-end / finish.
export function createUserMessage({ content, source } = {}) {
  return { role: 'user', content: content ?? [], source };
}

export class BlockAssembler {
  #blocks = [];
  #current = null;
  #finish = null;

  push(chunk) {
    if (!chunk || typeof chunk !== 'object') return;
    switch (chunk.type) {
      case 'block-start': {
        this.#current = { type: chunk.blockType ?? 'text', text: '' };
        this.#blocks.push(this.#current);
        break;
      }
      case 'text-delta': {
        if (!this.#current) {
          this.#current = { type: 'text', text: '' };
          this.#blocks.push(this.#current);
        }
        this.#current.text += typeof chunk.text === 'string' ? chunk.text : '';
        break;
      }
      case 'block-end': {
        if (chunk.block && typeof chunk.block === 'object') {
          if (this.#current) Object.assign(this.#current, chunk.block);
          else this.#blocks.push(chunk.block);
        }
        this.#current = null;
        break;
      }
      case 'finish': {
        this.#finish = chunk;
        break;
      }
      default:
        break;
    }
  }

  get finish() {
    return this.#finish;
  }

  blocks() {
    return this.#blocks.slice();
  }
}
