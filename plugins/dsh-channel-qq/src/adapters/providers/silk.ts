import * as fs from "node:fs";
import * as path from "node:path";
import { decode, isSilk } from "silk-wasm";

function pcmToWav(pcmData: Uint8Array, sampleRate: number, channels: number = 1, bitsPerSample: number = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const buffer = Buffer.alloc(fileSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength).copy(buffer, headerSize);

  return buffer;
}

function stripAmrHeader(buf: Buffer): Buffer {
  const AMR_HEADER = Buffer.from("#!AMR\n");
  if (buf.length > 6 && buf.subarray(0, 6).equals(AMR_HEADER)) {
    return buf.subarray(6);
  }
  return buf;
}

export async function convertSilkToWav(
  inputPath: string,
  outputDir?: string,
): Promise<{ wavPath: string; duration: number } | null> {
  if (!fs.existsSync(inputPath)) {
    return null;
  }

  const fileBuf = fs.readFileSync(inputPath);
  const strippedBuf = stripAmrHeader(fileBuf);
  const rawData = new Uint8Array(strippedBuf.buffer, strippedBuf.byteOffset, strippedBuf.byteLength);

  if (!isSilk(rawData)) {
    return null;
  }

  const sampleRate = 24000;
  const result = await decode(rawData, sampleRate);
  const wavBuffer = pcmToWav(result.data, sampleRate);

  const dir = outputDir || path.dirname(inputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wavPath = path.join(dir, `${baseName}.wav`);
  fs.writeFileSync(wavPath, wavBuffer);

  return { wavPath, duration: result.duration };
}