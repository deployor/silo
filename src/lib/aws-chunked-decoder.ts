
export class AwsChunkedDecoder extends TransformStream<Uint8Array, Uint8Array> {
	private leftover: Uint8Array | null = null;
	private phase: "size" | "data" | "crlf" = "size";
	private chunkSize = 0;
	private readonly MAX_HEADER_SIZE = 4096; // Safety limit for chunk size header

	constructor() {
		super({
			transform: (chunk, controller) => {
				this.processChunk(chunk, controller);
			},
			flush: (controller) => {
				if (this.leftover && this.leftover.length > 0) {
					console.warn(
						"[AwsChunkedDecoder] Stream ended with incomplete data",
						this.leftover.length,
					);
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

		// Efficiently handle leftovers:
		// Only allocate a new buffer if we have leftovers.
		if (this.leftover) {
			const totalLen = this.leftover.length + chunk.length;
			const temp = new Uint8Array(totalLen);
			temp.set(this.leftover);
			temp.set(chunk, this.leftover.length);
			currentChunk = temp;
			this.leftover = null;
		}

		const len = currentChunk.length;

		while (cursor < len) {
			if (this.phase === "size") {
				// We need to find CRLF
				// Use Buffer.indexOf if available for speed, otherwise loop.
				// In Bun/Node, Uint8Array can be viewed as Buffer without copy usually?
				// To be safe and portable-ish (but relying on Buffer for speed):
				// Buffer.from(buffer, offset, length) shares memory in Node/Bun?
				// Actually, standard loop is fine for short headers, but let's try to be efficient.
				
				// Search limit for header to prevent DoS
				const searchLimit = Math.min(len, cursor + this.MAX_HEADER_SIZE);
				let idx = -1;

				for (let i = cursor; i < searchLimit - 1; i++) {
					if (currentChunk[i] === 13 && currentChunk[i + 1] === 10) {
						idx = i;
						break;
					}
				}

				if (idx === -1) {
					// Not found
					if (len - cursor > this.MAX_HEADER_SIZE) {
						throw new Error("Chunk header exceeded maximum size");
					}
					// Save remaining as leftover
					this.leftover = currentChunk.slice(cursor);
					return;
				}

				// Found CRLF at idx
				// Extract size string
				// Use subarray to avoid copy, TextDecoder decodes from view
				const lineBytes = currentChunk.subarray(cursor, idx);
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
					// End of stream.
					// We treat this as the end of the body data.
					// Any subsequent data (trailers) is ignored for the PUT body.
					return;
				}

				this.phase = "data";
			} else if (this.phase === "data") {
				const available = len - cursor;
				const needed = this.chunkSize;

				if (available >= needed) {
					// We have the full chunk data (and possibly more)
					controller.enqueue(currentChunk.subarray(cursor, cursor + needed));
					cursor += needed;
					this.chunkSize = 0;
					this.phase = "crlf";
				} else {
					// We have partial data
					controller.enqueue(currentChunk.subarray(cursor));
					this.chunkSize -= available;
					// No leftover, we consumed everything
					return; 
				}
			} else if (this.phase === "crlf") {
				const available = len - cursor;
				if (available < 2) {
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
}
