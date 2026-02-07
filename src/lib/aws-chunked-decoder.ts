
export class AwsChunkedDecoder extends TransformStream<Uint8Array, Uint8Array> {
	private leftover: Uint8Array | null = null;
	private phase: "size" | "data" | "crlf" = "size";
	private chunkSize = 0;

	constructor() {
		super({
			transform: (chunk, controller) => {
				this.processChunk(chunk, controller);
			},
			flush: (controller) => {
				if (this.leftover && this.leftover.length > 0) {
					// Stream ended with incomplete data
					// We can warn or ignore. For S3, it usually ends cleanly.
				}
			},
		});
	}

	private processChunk(
		chunk: Uint8Array,
		controller: TransformStreamDefaultController<Uint8Array>,
	) {
		let cursor = 0;
		let currentChunk = chunk;

		// If we have leftovers from previous chunk, prepend them
		if (this.leftover) {
			const temp = new Uint8Array(this.leftover.length + chunk.length);
			temp.set(this.leftover);
			temp.set(chunk, this.leftover.length);
			currentChunk = temp;
			this.leftover = null;
		}

		while (cursor < currentChunk.length) {
			if (this.phase === "size") {
				// Search for CRLF in currentChunk starting at cursor
				const idx = this.indexOfCRLF(currentChunk, cursor);
				if (idx === -1) {
					// CRLF not found in this chunk, save the rest as leftover and wait for more
					this.leftover = currentChunk.slice(cursor);
					return;
				}

				// Parse size line
				const lineBytes = currentChunk.slice(cursor, idx);
				const line = new TextDecoder().decode(lineBytes);
				
				// Format: hex-size;key=value...
				const semiColon = line.indexOf(";");
				const sizeStr = semiColon === -1 ? line : line.slice(0, semiColon);
				const size = parseInt(sizeStr, 16);

				if (isNaN(size)) {
					throw new Error(`Invalid chunk size: ${sizeStr}`);
				}

				this.chunkSize = size;
				cursor = idx + 2; // Skip \r\n

				if (this.chunkSize === 0) {
					// End of stream (0-sized chunk)
					// We can stop processing here.
					// technically we should consume trailers, but for body extraction it's fine.
					return;
				}

				this.phase = "data";
			} else if (this.phase === "data") {
				const available = currentChunk.length - cursor;
				const needed = this.chunkSize;
				const toEmit = Math.min(available, needed);

				if (toEmit > 0) {
					// Zero-copy slice if possible (Buffer.subarray in Node, slice in Uint8Array)
					// In standard JS Uint8Array.slice copies. subarray does not.
					// Bun supports subarray.
					controller.enqueue(currentChunk.subarray(cursor, cursor + toEmit));
					cursor += toEmit;
					this.chunkSize -= toEmit;
				}

				if (this.chunkSize === 0) {
					this.phase = "crlf";
				} else {
					// We ran out of data in this chunk, but still need more for this chunk body
					return;
				}
			} else if (this.phase === "crlf") {
				const available = currentChunk.length - cursor;
				if (available < 2) {
					// Need at least 2 bytes for \r\n
					this.leftover = currentChunk.slice(cursor);
					return;
				}

				if (currentChunk[cursor] !== 13 || currentChunk[cursor + 1] !== 10) {
					throw new Error("Expected CRLF after chunk data");
				}

				cursor += 2;
				this.phase = "size";
			}
		}
	}

	private indexOfCRLF(buf: Uint8Array, start: number): number {
		for (let i = start; i < buf.length - 1; i++) {
			if (buf[i] === 13 && buf[i + 1] === 10) {
				return i;
			}
		}
		return -1;
	}
}
